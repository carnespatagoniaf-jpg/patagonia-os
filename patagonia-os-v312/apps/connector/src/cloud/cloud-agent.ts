// Canal con la nube de Patagonia Scale Connect (plan §5.3 y §5.4):
// - Vincular la PC con el código de 8 caracteres y guardar la credencial (credential-store.ts).
// - Latido cada 60 s con la versión y las balanzas que ve esta PC.
// - Bucle de trabajos: consulta larga a /claim, entrega del trabajo al JobExecutor, avance y cierre.
//   Sin conexión: espera creciente (1, 2, 5, 10, 30 s) y vuelve a intentar sola.
// - Si la nube dice que la credencial no sirve (401) o que la PC fue desvinculada (403): corta todo, borra la
//   credencial y la página local vuelve a pedir un código. Nunca sigue trabajando con una credencial revocada.

import { backoffDelay, DEFAULT_BACKOFF_MS } from "../worker/backoff";
import { silentLogger, type Logger } from "../log/logger";
import { CloudError, type CloudClient, type CloudConfig, type Credential, type PairResult, type SeenScale } from "./cloud-client";
import type { CredentialStore, StoredCredential } from "./credential-store";
import type { CloudJob, JobCloud, JobExecutor, JobItemResult, JobOutcome, JobProgress } from "./job-executor";

export type CloudState =
  | "sin_configurar" // falta la dirección de la nube en config.json
  | "sin_vincular"
  | "conectando"
  | "en_linea"
  | "sin_conexion"
  | "desvinculada"; // la nube rechazó la credencial: hay que vincular de nuevo

export interface CloudAgentOptions {
  client: CloudClient | null;
  store: CredentialStore;
  executor: JobExecutor;
  version: string;
  seenScales: () => SeenScale[];
  fingerprint: () => Promise<string | null>;
  logger?: Logger;
  heartbeatMs?: number;
  pollWaitSec?: number;
  backoffMs?: readonly number[];
  /** Mínimo entre dos consultas a /claim que volvieron vacías (por si la nube no hace consulta larga). */
  minPollGapMs?: number;
  /** Reintentos del cierre de un trabajo. */
  finishAttempts?: number;
  /** Se le pasa la configuración de la nube después de cada latido que anduvo (balanzas y en qué puerto está cada una). */
  onConfig?: (config: CloudConfig) => void | Promise<void>;
  /**
   * Trabajos a la vez (cada balanza tiene su propio trabajador: dos envíos a dos balanzas corren en paralelo; dos a la
   * misma esperan en la cola de esa balanza). Por omisión, 4.
   */
  maxConcurrentJobs?: number;
}

export interface PairInput {
  code: string;
  name: string;
  recoverId?: string | null;
  forceNew?: boolean;
}

export type AgentPairResult = PairResult | { kind: "error"; error: "no_configurado" | "ya_vinculada" | "ocupado" | "sin_conexion" | "error_servidor" };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class CloudAgent {
  private readonly log: Logger;
  private readonly heartbeatMs: number;
  private readonly pollWaitSec: number;
  private readonly backoffMs: readonly number[];
  private readonly minPollGapMs: number;
  private readonly finishAttempts: number;

  private credential: StoredCredential | null = null;
  private state: CloudState = "sin_vincular";
  private abort: AbortController | null = null;
  private loops: Promise<void>[] = [];
  private pairing = false;
  private lastHeartbeatAt: string | null = null;
  private lastError: { kind: string; message: string; at: string } | null = null;
  private readonly maxConcurrentJobs: number;
  private readonly currentJobs = new Map<string, { id: string; kind: string; scaleKey: string; startedAt: string }>();
  private wakeHeartbeat: (() => void) | null = null;
  private reconnectAttempt = 0;
  private jobsDone = 0;
  private jobsFailed = 0;

  constructor(private readonly options: CloudAgentOptions) {
    this.log = (options.logger ?? silentLogger).child({ module: "nube" });
    this.heartbeatMs = options.heartbeatMs ?? 60_000;
    this.pollWaitSec = options.pollWaitSec ?? 25;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.minPollGapMs = options.minPollGapMs ?? 1000;
    this.finishAttempts = options.finishAttempts ?? 10;
    this.maxConcurrentJobs = Math.max(1, options.maxConcurrentJobs ?? 4);
  }

  /** Late ya (por ejemplo, después de identificar balanzas), sin esperar el minuto. */
  heartbeatNow(): void {
    this.wakeHeartbeat?.();
  }

  get isPaired(): boolean {
    return this.credential !== null;
  }

  get configured(): boolean {
    return this.options.client !== null;
  }

  async start(): Promise<void> {
    if (!this.options.client) {
      this.state = "sin_configurar";
      this.log.warn("Falta la dirección de la nube (cloud.url en config.json): Scale Connect trabaja solo en esta PC");
      return;
    }
    try {
      this.credential = await this.options.store.load();
    } catch (error) {
      this.log.error("No se pudo leer la credencial guardada: hay que vincular de nuevo", { error });
      this.credential = null;
    }
    if (!this.credential) {
      this.state = "sin_vincular";
      this.log.info("Esta PC todavía no está vinculada: abrí http://127.0.0.1:9120/vincular");
      return;
    }
    this.log.info("Credencial cargada", { connector: this.credential.connectorId, name: this.credential.name, scheme: this.options.store.scheme });
    this.runLoops();
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  async pair(input: PairInput): Promise<AgentPairResult> {
    const client = this.options.client;
    if (!client) return { kind: "error", error: "no_configurado" };
    if (this.credential) return { kind: "error", error: "ya_vinculada" };
    if (this.pairing) return { kind: "error", error: "ocupado" };
    this.pairing = true;
    try {
      let fingerprint: string | null = null;
      try {
        fingerprint = await this.options.fingerprint();
      } catch (error) {
        this.log.warn("No se pudo calcular la huella de la PC (no se va a poder reconocer al reinstalar)", { error });
      }
      let result: PairResult;
      try {
        result = await client.pair({ code: input.code, name: input.name, fingerprint, version: this.options.version, recoverId: input.recoverId, forceNew: input.forceNew });
      } catch (error) {
        const network = error instanceof CloudError && error.kind === "network";
        this.log.warn("No se pudo vincular", { error });
        return { kind: "error", error: network ? "sin_conexion" : "error_servidor" };
      }
      if (result.kind !== "paired") {
        this.log.info("Vinculación sin terminar", { result: result.kind === "error" ? result.error : "elegir" });
        return result;
      }
      const credential: StoredCredential = {
        connectorId: result.connectorId,
        secret: result.secret,
        name: result.name,
        branchId: result.branchId,
        pairedAt: new Date().toISOString(),
      };
      await this.options.store.save(credential);
      this.credential = credential;
      this.lastError = null;
      this.log.info(result.recovered ? "PC recuperada: es la misma de antes" : "PC vinculada", { connector: result.connectorId, name: result.name });
      this.runLoops();
      return { ...result, secret: "[guardado]" };
    } finally {
      this.pairing = false;
    }
  }

  status(): Record<string, unknown> {
    return {
      state: this.state,
      configured: this.configured,
      paired: this.isPaired,
      connectorId: this.credential?.connectorId ?? null,
      name: this.credential?.name ?? null,
      pairedAt: this.credential?.pairedAt ?? null,
      credentialScheme: this.options.store.scheme,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
      currentJob: [...this.currentJobs.values()][0] ?? null,
      currentJobs: [...this.currentJobs.values()],
      jobsDone: this.jobsDone,
      jobsFailed: this.jobsFailed,
    };
  }

  // ---------------------------------------------------------------------------------------------- bucles
  private runLoops(): void {
    const credential = this.credential;
    if (!credential || !this.options.client) return;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.state = "conectando";
    const cred: Credential = { connectorId: credential.connectorId, secret: credential.secret };
    this.loops = [this.heartbeatLoop(cred, abort.signal), this.jobLoop(cred, abort.signal)];
  }

  private markOnline(): void {
    if (this.state !== "en_linea") this.log.info("Conectado con Patagonia");
    this.state = "en_linea";
    this.reconnectAttempt = 0;
  }

  private markOffline(error: unknown): void {
    const kind = error instanceof CloudError ? error.kind : "error";
    const message = error instanceof Error ? error.message : String(error);
    if (this.state !== "sin_conexion") this.log.warn("Sin conexión con Patagonia: se reintenta solo", { kind, message });
    this.state = "sin_conexion";
    this.lastError = { kind, message: message.slice(0, 300), at: new Date().toISOString() };
  }

  /** La nube rechazó la credencial: se corta todo y se borra. Solo pasa una vez por credencial. */
  private async needsPairing(error: CloudError, cred: Credential): Promise<void> {
    if (!this.credential || this.credential.connectorId !== cred.connectorId) return;
    this.log.warn(error.kind === "revoked" ? "Esta PC fue desvinculada desde Patagonia" : "La credencial ya no sirve: hay que vincular de nuevo", {
      connector: cred.connectorId,
    });
    this.credential = null;
    this.state = "desvinculada";
    this.lastError = { kind: error.kind, message: error.message.slice(0, 300), at: new Date().toISOString() };
    this.abort?.abort();
    try {
      await this.options.store.clear();
    } catch (clearError) {
      this.log.error("No se pudo borrar la credencial", { error: clearError });
    }
  }

  private async heartbeatLoop(cred: Credential, signal: AbortSignal): Promise<void> {
    const client = this.options.client!;
    while (!signal.aborted) {
      try {
        const r = await client.heartbeat(cred, { version: this.options.version, scales: this.options.seenScales() }, signal);
        this.lastHeartbeatAt = new Date().toISOString();
        if (r.name && this.credential) this.credential.name = r.name;
        this.markOnline();
        if (this.options.onConfig) {
          // Qué balanza de Patagonia está en qué puerto (la web la pudo vincular recién). Si falla, sigue igual.
          try {
            await this.options.onConfig(await client.config(cred, signal));
          } catch (error) {
            if (error instanceof CloudError && error.needsPairing) return this.needsPairing(error, cred);
            this.log.debug("No se pudo traer la configuración", { error });
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof CloudError && error.needsPairing) return this.needsPairing(error, cred);
        this.markOffline(error);
      }
      const wake = new AbortController();
      this.wakeHeartbeat = () => wake.abort();
      await sleep(this.heartbeatMs, AbortSignal.any([signal, wake.signal]));
      this.wakeHeartbeat = null;
    }
  }

  private async jobLoop(cred: Credential, signal: AbortSignal): Promise<void> {
    const running = new Set<Promise<void>>();
    try {
      await this.claimLoop(cred, signal, running);
    } finally {
      // Al apagar: los trabajos en curso terminan (cortados por la señal) y cierran en la nube.
      await Promise.allSettled([...running]);
    }
  }

  private async claimLoop(cred: Credential, signal: AbortSignal, running: Set<Promise<void>>): Promise<void> {
    const client = this.options.client!;
    let attempt = 0;
    while (!signal.aborted) {
      // Lleno: espera a que termine alguno antes de pedir otro.
      if (running.size >= this.maxConcurrentJobs) {
        await Promise.race(running);
        continue;
      }
      const started = Date.now();
      let job: CloudJob | null;
      try {
        job = await client.claim(cred, this.pollWaitSec, signal);
        attempt = 0;
        this.markOnline();
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof CloudError && error.needsPairing) return this.needsPairing(error, cred);
        this.markOffline(error);
        this.reconnectAttempt = attempt + 1;
        await sleep(backoffDelay(attempt, this.backoffMs), signal);
        attempt += 1;
        continue;
      }
      if (job) {
        const p: Promise<void> = this.runJob(cred, job, signal).finally(() => running.delete(p));
        running.add(p);
        continue;
      }
      const gap = this.minPollGapMs - (Date.now() - started);
      if (gap > 0) await sleep(gap, signal);
    }
  }

  private async runJob(cred: Credential, job: CloudJob, signal: AbortSignal): Promise<void> {
    const client = this.options.client!;
    const log = this.log.child({ job: job.id, scale: job.scaleKey });
    log.info("Trabajo recibido", { kind: job.kind, requested: job.requested });
    this.currentJobs.set(job.id, { id: job.id, kind: job.kind, scaleKey: job.scaleKey, startedAt: new Date().toISOString() });

    // El trabajo se corta si el servicio se apaga, si la PC se desvincula o si la nube ya lo dio por cerrado.
    const jobAbort = new AbortController();
    const onStop = () => jobAbort.abort();
    signal.addEventListener("abort", onStop, { once: true });
    let seq = 0;
    const unsent: JobItemResult[] = [];

    const progress = async (update: JobProgress): Promise<void> => {
      const items = [...(update.items ?? [])];
      if (jobAbort.signal.aborted) {
        unsent.push(...items);
        return;
      }
      seq += 1;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await client.progress(cred, { jobId: job.id, seq, done: update.done, total: update.total, text: update.text ?? null, items }, signal);
          return;
        } catch (error) {
          if (error instanceof CloudError) {
            if (error.needsPairing) {
              await this.needsPairing(error, cred);
              jobAbort.abort();
              break;
            }
            if (error.kind === "conflict" || error.kind === "not_found") {
              log.warn("La nube ya cerró este trabajo: se corta", { kind: error.kind });
              jobAbort.abort();
              break;
            }
            if (error.kind === "bad_request") {
              log.error("La nube rechazó el avance", { error });
              break;
            }
          }
          if (signal.aborted) break;
          await sleep(backoffDelay(attempt, this.backoffMs), signal);
        }
      }
      // No se pudo informar: esos productos viajan con el cierre (nunca se pierden en silencio).
      unsent.push(...items);
    };

    const cloud: JobCloud = {
      engine: (action, args) => client.engine(cred, { jobId: job.id, action, args }, jobAbort.signal),
      config: () => client.config(cred, jobAbort.signal),
    };
    let outcome: JobOutcome;
    try {
      outcome = await this.options.executor.execute(job, { signal: jobAbort.signal, progress, cloud });
    } catch (error) {
      log.error("El ejecutor falló", { error });
      outcome = { status: "failed", errorCode: "error_conector", items: [] };
    }
    signal.removeEventListener("abort", onStop);

    const items = [...unsent, ...(outcome.items ?? [])];
    for (let attempt = 0; attempt < this.finishAttempts; attempt += 1) {
      if (!this.credential || this.credential.connectorId !== cred.connectorId) break;
      try {
        await client.finish(cred, { jobId: job.id, status: outcome.status, counters: outcome.counters, items, error: outcome.errorCode ?? null });
        if (outcome.status === "failed") this.jobsFailed += 1;
        else this.jobsDone += 1;
        log.info("Trabajo cerrado", { status: outcome.status, items: items.length, error: outcome.errorCode ?? null });
        break;
      } catch (error) {
        if (error instanceof CloudError) {
          if (error.needsPairing) {
            await this.needsPairing(error, cred);
            break;
          }
          if (error.kind === "conflict" || error.kind === "not_found") {
            log.warn("El trabajo ya estaba cerrado en la nube", { kind: error.kind });
            break;
          }
          if (error.kind === "bad_request") {
            log.error("La nube rechazó el cierre", { error });
            break;
          }
        }
        // Apagando: un solo intento. Si no llegó, la nube lo da por fallido a los 30 minutos sin avance.
        if (signal.aborted) {
          log.warn("No se pudo cerrar el trabajo antes de apagar", { error });
          break;
        }
        log.warn("No se pudo informar el cierre: se reintenta", { attempt: attempt + 1, error });
        await sleep(backoffDelay(attempt, this.backoffMs), signal);
      }
    }
    this.currentJobs.delete(job.id);
  }
}
