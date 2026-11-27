// Trabajador por dispositivo: uno por balanza, aislado de los demás.
//
// - Es el dueño del puerto de SU balanza (lo pide al PortManager).
// - Cola propia: un trabajo a la vez.
// - Tiempo de espera por comando (ctx.command) y vigía del trabajo: si el
//   trabajo no avanza en `watchdogMs`, se aborta, se libera el puerto, se marca
//   fallido y se reconecta.
// - Reconexión con espera creciente ante desconexión.
// - `enqueue` nunca rechaza: siempre devuelve un resultado (hecho, fallido o
//   interrumpido). Una falla acá no toca a los otros trabajadores.

import { randomUUID } from "node:crypto";
import type { ByteLink } from "../link/byte-link";
import { LinkError, isLinkError } from "../link/link-error";
import type { PortLease, PortManager, ResourceKey } from "../ports/port-manager";
import type { JobErrorInfo, JobJournal } from "../journal/job-journal";
import { silentLogger, type Logger } from "../log/logger";
import { DEFAULT_BACKOFF_MS, backoffDelay } from "./backoff";

export type WorkerState = "stopped" | "connecting" | "ready" | "busy" | "reconnecting";

export interface DeviceSpec {
  id: string;
  name: string;
  resource: ResourceKey;
  createLink: () => ByteLink;
}

export interface DeviceWorkerOptions {
  portManager: PortManager;
  journal?: JobJournal;
  logger?: Logger;
  backoffMs?: readonly number[];
  /** Si un trabajo no avanza en este tiempo, se aborta. */
  watchdogMs?: number;
  /** Tiempo de espera por comando, si el trabajo no indica otro. */
  commandTimeoutMs?: number;
  /** Cuánto espera un trabajo a que la balanza esté conectada. */
  waitReadyMs?: number;
  now?: () => Date;
}

export interface CommandOptions {
  timeoutMs?: number;
  until?: (received: Uint8Array) => boolean;
  /** Descarta bytes viejos antes de escribir (por omisión, sí). */
  discardBefore?: boolean;
}

export interface JobContext {
  readonly jobId: string;
  readonly deviceId: string;
  /** Se activa si el vigía aborta el trabajo o se apaga el servicio. */
  readonly signal: AbortSignal;
  /** Escribe y espera la respuesta, con tiempo de espera por comando. */
  command(data: Uint8Array, options?: CommandOptions): Promise<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
  read(options?: { timeoutMs?: number; until?: (received: Uint8Array) => boolean }): Promise<Uint8Array>;
  /** Anota en el diario un paso confirmado (y cuenta como avance para el vigía). */
  confirmStep(key: string, data?: unknown): Promise<void>;
  /** Avisa al vigía que el trabajo sigue avanzando sin hablar con la balanza. */
  heartbeat(): void;
}

export interface JobRequest<T> {
  id?: string;
  kind: string;
  meta?: Record<string, unknown>;
  watchdogMs?: number;
  run(ctx: JobContext): Promise<T>;
}

export type JobOutcome<T> =
  | { jobId: string; status: "done"; result: T }
  | { jobId: string; status: "failed" | "interrupted"; error: JobErrorInfo };

export interface WorkerStatus {
  id: string;
  name: string;
  resource: ResourceKey;
  state: WorkerState;
  connectedSince: string | null;
  queueLength: number;
  currentJob: { id: string; kind: string; startedAt: string; lastProgressAt: string } | null;
  lastError: { code: string; message: string; at: string } | null;
  reconnectAttempt: number;
  nextRetryAt: string | null;
  jobsDone: number;
  jobsFailed: number;
}

interface QueueItem {
  jobId: string;
  request: JobRequest<unknown>;
  resolve: (outcome: JobOutcome<unknown>) => void;
}

class WatchdogTripped extends Error {}
class WorkerStopping extends Error {}

export class DeviceWorker {
  readonly id: string;
  readonly name: string;
  readonly resource: ResourceKey;

  private readonly spec: DeviceSpec;
  private readonly pm: PortManager;
  private readonly journal?: JobJournal;
  private readonly log: Logger;
  private readonly backoff: readonly number[];
  private readonly watchdogMs: number;
  private readonly commandTimeoutMs: number;
  private readonly waitReadyMs: number;
  private readonly now: () => Date;

  private running = false;
  private stopping = false;
  private state: WorkerState = "stopped";
  private lease: PortLease | null = null;
  private stopDisconnectWatch: (() => void) | null = null;
  private connecting = false;
  private reconnectAttempt = 0;
  private nextRetryAt: Date | null = null;
  private connectedSince: Date | null = null;
  private wakeSleep: (() => void) | null = null;
  private readyWaiters = new Set<(ok: boolean) => void>();
  private queue: QueueItem[] = [];
  private pumping: Promise<void> | null = null;
  private current: { id: string; kind: string; startedAt: Date; lastProgressAt: Date } | null = null;
  private cancelCurrent: ((reason: Error) => void) | null = null;
  private lastError: { code: string; message: string; at: Date } | null = null;
  private jobsDone = 0;
  private jobsFailed = 0;

  constructor(spec: DeviceSpec, options: DeviceWorkerOptions) {
    this.spec = spec;
    this.id = spec.id;
    this.name = spec.name;
    this.resource = spec.resource;
    this.pm = options.portManager;
    this.journal = options.journal;
    this.log = (options.logger ?? silentLogger).child({ device: spec.id });
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.watchdogMs = options.watchdogMs ?? 30_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 2000;
    this.waitReadyMs = options.waitReadyMs ?? 15_000;
    this.now = options.now ?? (() => new Date());
  }

  /** Empieza a conectar (y a reconectar solo si se cae). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    void this.connectLoop(false);
  }

  /** Apaga: interrumpe el trabajo en curso, descarta la cola y libera el puerto. */
  async stop(): Promise<void> {
    if (!this.running && this.state === "stopped") return;
    this.running = false;
    this.stopping = true;
    this.wakeSleep?.();
    for (const waiter of [...this.readyWaiters]) waiter(false);
    this.readyWaiters.clear();
    const pending = this.queue.splice(0);
    for (const item of pending) {
      item.resolve({ jobId: item.jobId, status: "interrupted", error: { code: "stopped", message: "Se apagó el servicio antes de empezar este trabajo." } });
    }
    this.cancelCurrent?.(new WorkerStopping("stop"));
    await this.pumping?.catch(() => undefined);
    await this.dropConnection(false);
    this.state = "stopped";
    this.nextRetryAt = null;
  }

  enqueue<T>(request: JobRequest<T>): Promise<JobOutcome<T>> {
    const jobId = request.id ?? randomUUID();
    if (!this.running) {
      return Promise.resolve({ jobId, status: "failed", error: { code: "stopped", message: `${this.name} no está activa.` } });
    }
    return new Promise<JobOutcome<T>>((resolve) => {
      this.queue.push({ jobId, request: request as JobRequest<unknown>, resolve: resolve as (o: JobOutcome<unknown>) => void });
      this.pump();
    });
  }

  status(): WorkerStatus {
    return {
      id: this.id,
      name: this.name,
      resource: this.resource,
      state: this.state,
      connectedSince: this.connectedSince?.toISOString() ?? null,
      queueLength: this.queue.length,
      currentJob: this.current
        ? {
            id: this.current.id,
            kind: this.current.kind,
            startedAt: this.current.startedAt.toISOString(),
            lastProgressAt: this.current.lastProgressAt.toISOString(),
          }
        : null,
      lastError: this.lastError ? { ...this.lastError, at: this.lastError.at.toISOString() } : null,
      reconnectAttempt: this.reconnectAttempt,
      nextRetryAt: this.nextRetryAt?.toISOString() ?? null,
      jobsDone: this.jobsDone,
      jobsFailed: this.jobsFailed,
    };
  }

  // ───────────────────────── conexión ─────────────────────────

  private async connectLoop(waitFirst: boolean): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try {
      if (waitFirst) await this.sleepBackoff();
      while (this.running && !this.lease) {
        this.state = "connecting";
        this.nextRetryAt = null;
        try {
          const lease = await this.pm.open(this.resource, `${this.name} (${this.id})`, this.spec.createLink);
          if (!this.running) {
            await lease.release();
            break;
          }
          this.lease = lease;
          this.connectedSince = this.now();
          this.reconnectAttempt = 0;
          this.stopDisconnectWatch = lease.link.onDisconnect((error) => this.onDisconnect(lease, error));
          this.state = this.current ? "busy" : "ready";
          this.log.info("Balanza conectada", { resource: this.resource });
          for (const waiter of [...this.readyWaiters]) waiter(true);
          this.readyWaiters.clear();
          this.pump();
        } catch (error) {
          this.noteError(error);
          this.log.warn("No se pudo conectar con la balanza", { resource: this.resource, error });
          if (!this.running) break;
          await this.sleepBackoff();
        }
      }
    } finally {
      this.connecting = false;
    }
  }

  private async sleepBackoff(): Promise<void> {
    const delay = backoffDelay(this.reconnectAttempt, this.backoff);
    this.reconnectAttempt += 1;
    this.state = "reconnecting";
    this.nextRetryAt = new Date(this.now().getTime() + delay);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, delay);
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wakeSleep === done) self.wakeSleep = null;
        resolve();
      }
      this.wakeSleep = done;
    });
  }

  private onDisconnect(lease: PortLease, error: LinkError): void {
    if (this.lease !== lease) return;
    this.noteError(error);
    this.log.warn("Se desconectó la balanza", { resource: this.resource, error });
    void this.dropConnection(true);
  }

  /** Libera el puerto. Si `reconnect`, vuelve a intentar con espera creciente. */
  private async dropConnection(reconnect: boolean): Promise<void> {
    const lease = this.lease;
    this.lease = null;
    this.connectedSince = null;
    this.stopDisconnectWatch?.();
    this.stopDisconnectWatch = null;
    if (lease) {
      try {
        await lease.release();
      } catch (error) {
        this.log.warn("Error al liberar el puerto", { error });
      }
    }
    if (reconnect && this.running) void this.connectLoop(true);
  }

  private waitReady(timeoutMs: number): Promise<boolean> {
    if (this.lease) return Promise.resolve(true);
    if (!this.running) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = (ok: boolean) => {
        clearTimeout(timer);
        this.readyWaiters.delete(waiter);
        resolve(ok);
      };
      const timer = setTimeout(() => waiter(false), timeoutMs);
      this.readyWaiters.add(waiter);
    });
  }

  // ───────────────────────── trabajos ─────────────────────────

  private pump(): void {
    // Sin conexión igual se atiende la cola: cada trabajo espera `waitReadyMs`.
    if (this.pumping || this.queue.length === 0 || !this.running) return;
    this.pumping = (async () => {
      while (this.running && this.queue.length > 0) {
        const item = this.queue.shift()!;
        let outcome: JobOutcome<unknown>;
        try {
          outcome = await this.runJob(item);
        } catch (error) {
          outcome = { jobId: item.jobId, status: "failed", error: { code: "internal", message: messageOf(error) } };
        }
        if (outcome.status === "done") this.jobsDone += 1;
        else this.jobsFailed += 1;
        item.resolve(outcome);
      }
    })().finally(() => {
      this.pumping = null;
      if (this.running && this.queue.length > 0) this.pump();
    });
  }

  private async runJob(item: QueueItem): Promise<JobOutcome<unknown>> {
    const { jobId, request } = item;
    const connected = await this.waitReady(this.waitReadyMs);
    const lease = this.lease;
    if (!connected || !lease) {
      const error = this.stopping
        ? { code: "stopped", message: "Se apagó el servicio antes de empezar este trabajo." }
        : {
            code: "not_connected",
            message: `${this.name} no está conectada${this.lastError ? `: ${this.lastError.message}` : "."}`,
          };
      return { jobId, status: this.stopping ? "interrupted" : "failed", error };
    }

    try {
      await this.journal?.begin({ id: jobId, deviceId: this.id, kind: request.kind, meta: request.meta });
    } catch (error) {
      this.log.error("No se pudo anotar el trabajo en el diario", { jobId, error });
      return { jobId, status: "failed", error: { code: "journal", message: "No se pudo anotar el trabajo en el diario local." } };
    }

    const link = lease.link;
    const controller = new AbortController();
    const signal = controller.signal;
    const watchdogMs = request.watchdogMs ?? this.watchdogMs;
    const startedAt = this.now();
    this.current = { id: jobId, kind: request.kind, startedAt, lastProgressAt: startedAt };
    this.state = "busy";

    let tripped = false;
    let stoppedByService = false;
    let rejectGuard: (reason: Error) => void = () => undefined;
    const guard = new Promise<never>((_, reject) => {
      rejectGuard = reject;
    });
    guard.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      if (signal.aborted) return;
      clearTimeout(timer);
      if (this.current) this.current.lastProgressAt = this.now();
      timer = setTimeout(() => {
        tripped = true;
        controller.abort();
        rejectGuard(new WatchdogTripped());
      }, watchdogMs);
    };
    this.cancelCurrent = (reason) => {
      stoppedByService = reason instanceof WorkerStopping;
      controller.abort();
      rejectGuard(reason);
    };
    arm();

    const alive = () => {
      if (signal.aborted) throw new LinkError("aborted", "El trabajo se canceló.");
    };
    const ctx: JobContext = {
      jobId,
      deviceId: this.id,
      signal,
      write: async (data) => {
        alive();
        await link.write(data);
      },
      read: async (options = {}) => {
        alive();
        const data = await link.read({ timeoutMs: options.timeoutMs ?? this.commandTimeoutMs, until: options.until, signal });
        arm();
        return data;
      },
      command: async (data, options = {}) => {
        alive();
        if (options.discardBefore !== false) link.discardInput();
        await link.write(data);
        const reply = await link.read({ timeoutMs: options.timeoutMs ?? this.commandTimeoutMs, until: options.until, signal });
        arm();
        return reply;
      },
      confirmStep: async (key, data) => {
        alive();
        if (this.journal) await this.journal.confirmStep(jobId, key, data);
        arm();
      },
      heartbeat: () => arm(),
    };

    const work = Promise.resolve().then(() => request.run(ctx));
    work.catch(() => undefined); // si el vigía ganó, lo que pase después ya no importa

    let outcome: JobOutcome<unknown>;
    try {
      const result = await Promise.race([work, guard]);
      outcome = { jobId, status: "done", result };
    } catch (error) {
      outcome = { jobId, ...this.classifyJobError(error, tripped, stoppedByService, link, watchdogMs) };
    } finally {
      clearTimeout(timer);
      if (!signal.aborted) controller.abort();
      this.cancelCurrent = null;
      this.current = null;
    }

    if (tripped) {
      this.log.error("El vigía abortó el trabajo: no avanzaba", { jobId, kind: request.kind, watchdogMs });
      this.noteError(new LinkError("aborted", (outcome as { error: JobErrorInfo }).error.message));
      // Se libera el puerto (la balanza puede haber quedado en un estado raro) y se reconecta.
      await this.dropConnection(true);
    }

    try {
      if (this.journal) {
        if (outcome.status === "done") await this.journal.finish(jobId, "done");
        else await this.journal.finish(jobId, outcome.status, outcome.error);
      }
    } catch (error) {
      this.log.error("No se pudo cerrar el trabajo en el diario", { jobId, error });
    }

    if (this.lease) this.state = "ready";
    if (outcome.status !== "done") this.log.warn("Trabajo sin terminar", { jobId, kind: request.kind, outcome: outcome.status, error: outcome.error });
    else this.log.info("Trabajo terminado", { jobId, kind: request.kind });
    return outcome;
  }

  private classifyJobError(
    error: unknown,
    tripped: boolean,
    stoppedByService: boolean,
    link: ByteLink,
    watchdogMs: number,
  ): { status: "failed" | "interrupted"; error: JobErrorInfo } {
    if (tripped) {
      return {
        status: "failed",
        error: {
          code: "watchdog",
          message: `${this.name} no avanzó en ${Math.round(watchdogMs / 1000)} s: se abortó el trabajo y se liberó el puerto.`,
        },
      };
    }
    if (stoppedByService || this.stopping) {
      return { status: "interrupted", error: { code: "stopped", message: "Se apagó el servicio con el trabajo a medias. Hay que reanudarlo." } };
    }
    if (isLinkError(error, "closed") || (!link.isOpen && isLinkError(error))) {
      return {
        status: "interrupted",
        error: { code: "disconnected", message: `Se desconectó ${this.name} a mitad del trabajo. Hay que releer la balanza y reanudar lo pendiente.` },
      };
    }
    if (isLinkError(error, "timeout")) return { status: "failed", error: { code: "timeout", message: error.message } };
    if (isLinkError(error)) return { status: "failed", error: { code: error.code, message: error.message } };
    return { status: "failed", error: { code: "job_error", message: messageOf(error) } };
  }

  private noteError(error: unknown): void {
    this.lastError = {
      code: isLinkError(error) ? error.code : "io",
      message: messageOf(error),
      at: this.now(),
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
