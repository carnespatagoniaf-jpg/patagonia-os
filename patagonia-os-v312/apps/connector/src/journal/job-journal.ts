// Diario de trabajos: cada trabajo y cada paso confirmado (por ejemplo "PLU
// 1234 escrito y releído") se anota en disco al instante. Al reiniciar el
// servicio, un trabajo que estaba "en curso" pasa a "interrumpido, para
// reanudar": NUNCA se vuelve a mandar solo. Reanudar = releer la balanza y
// hacer únicamente lo pendiente, y eso lo decide el controlador del protocolo.
//
// La interfaz `JobJournal` es la que usan los trabajadores. Hoy la implementa
// `StoredJobJournal` sobre un JSON con escritura atómica; más adelante se
// cambia el almacenamiento por SQLite (plan 5.2) sin tocar a quienes la usan.

import { cleanupTempFiles, readJsonFile, writeFileAtomic } from "../storage/atomic-file";

export type JobStatus = "running" | "done" | "failed" | "interrupted";
export type JobEndStatus = Exclude<JobStatus, "running">;

export interface JobStep {
  key: string;
  at: string;
  data?: unknown;
}

export interface JobErrorInfo {
  code: string;
  message: string;
}

export interface JobRecord {
  id: string;
  deviceId: string;
  kind: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  steps: JobStep[];
  error?: JobErrorInfo;
  /** true = quedó a medias y se puede reanudar (releyendo la balanza primero). */
  resumable: boolean;
  meta?: Record<string, unknown>;
}

export interface RecoveryReport {
  /** Trabajos que estaban en curso cuando se apagó o cayó el servicio. */
  interrupted: JobRecord[];
  /** El archivo estaba dañado y se apartó (ruta del apartado). */
  corruptMovedTo?: string;
  tempFilesRemoved: number;
}

export interface JobJournal {
  /** Carga el diario y marca como interrumpido lo que estaba en curso. */
  open(): Promise<RecoveryReport>;
  begin(job: { id: string; deviceId: string; kind: string; meta?: Record<string, unknown> }): Promise<void>;
  /** Anota un paso confirmado. Si no se puede anotar, rechaza: el trabajo no debe seguir. */
  confirmStep(jobId: string, key: string, data?: unknown): Promise<void>;
  finish(jobId: string, status: JobEndStatus, error?: JobErrorInfo): Promise<void>;
  get(jobId: string): JobRecord | undefined;
  list(filter?: { deviceId?: string; status?: JobStatus }): JobRecord[];
  close(): Promise<void>;
}

/** Dónde se guardan los registros. JSON hoy; SQLite más adelante. */
export interface JournalStorage {
  load(): Promise<{ records: JobRecord[]; corruptMovedTo?: string; tempFilesRemoved: number }>;
  save(records: JobRecord[]): Promise<void>;
}

interface JournalFile {
  format: "patagonia-scale-connect/jobs";
  version: 1;
  records: JobRecord[];
}

export class JsonFileJournalStorage implements JournalStorage {
  constructor(private readonly file: string) {}

  async load() {
    const tempFilesRemoved = await cleanupTempFiles(this.file);
    const result = await readJsonFile<JournalFile>(this.file);
    if (result.status === "missing") return { records: [], tempFilesRemoved };
    if (result.status === "corrupt") return { records: [], corruptMovedTo: result.movedTo, tempFilesRemoved };
    const records = Array.isArray(result.value?.records) ? result.value.records : [];
    return { records, tempFilesRemoved };
  }

  async save(records: JobRecord[]): Promise<void> {
    const file: JournalFile = { format: "patagonia-scale-connect/jobs", version: 1, records };
    await writeFileAtomic(this.file, JSON.stringify(file, null, 1));
  }
}

export class MemoryJournalStorage implements JournalStorage {
  records: JobRecord[] = [];
  saves = 0;
  failNextSave: Error | null = null;

  async load() {
    return { records: structuredClone(this.records), tempFilesRemoved: 0 };
  }

  async save(records: JobRecord[]): Promise<void> {
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = null;
      throw error;
    }
    this.saves += 1;
    this.records = structuredClone(records);
  }
}

export const RESTART_INTERRUPTED: JobErrorInfo = {
  code: "restart",
  message:
    "El servicio se reinició con este trabajo en curso. No se reenvía solo: hay que releer la balanza y reanudar solo lo pendiente.",
};

export interface StoredJobJournalOptions {
  /** Cuántos trabajos terminados se conservan (los en curso/interrumpidos no se borran). */
  keepFinished?: number;
  now?: () => Date;
}

export class StoredJobJournal implements JobJournal {
  private readonly records = new Map<string, JobRecord>();
  private chain: Promise<void> = Promise.resolve();
  private opened = false;
  private readonly keepFinished: number;
  private readonly now: () => Date;

  constructor(
    private readonly storage: JournalStorage,
    options: StoredJobJournalOptions = {},
  ) {
    this.keepFinished = options.keepFinished ?? 200;
    this.now = options.now ?? (() => new Date());
  }

  async open(): Promise<RecoveryReport> {
    const loaded = await this.storage.load();
    this.records.clear();
    const interrupted: JobRecord[] = [];
    const at = this.now().toISOString();
    for (const record of loaded.records) {
      if (!record || typeof record.id !== "string") continue;
      if (record.status === "running") {
        record.status = "interrupted";
        record.resumable = true;
        record.error = { ...RESTART_INTERRUPTED };
        record.updatedAt = at;
        interrupted.push(record);
      }
      this.records.set(record.id, record);
    }
    this.opened = true;
    if (interrupted.length > 0 || loaded.corruptMovedTo) await this.persist();
    return {
      interrupted: interrupted.map((r) => structuredClone(r)),
      corruptMovedTo: loaded.corruptMovedTo,
      tempFilesRemoved: loaded.tempFilesRemoved,
    };
  }

  async begin(job: { id: string; deviceId: string; kind: string; meta?: Record<string, unknown> }): Promise<void> {
    this.assertOpen();
    if (this.records.has(job.id)) throw new Error(`Ya existe el trabajo ${job.id} en el diario.`);
    const at = this.now().toISOString();
    this.records.set(job.id, {
      id: job.id,
      deviceId: job.deviceId,
      kind: job.kind,
      status: "running",
      createdAt: at,
      updatedAt: at,
      steps: [],
      resumable: false,
      meta: job.meta,
    });
    await this.persist();
  }

  async confirmStep(jobId: string, key: string, data?: unknown): Promise<void> {
    const record = this.require(jobId);
    if (record.status !== "running") throw new Error(`El trabajo ${jobId} ya no está en curso.`);
    const at = this.now().toISOString();
    const step: JobStep = data === undefined ? { key, at } : { key, at, data };
    record.steps.push(step);
    record.updatedAt = at;
    try {
      await this.persist();
    } catch (error) {
      // Lo que no quedó en disco no cuenta como confirmado.
      const index = record.steps.lastIndexOf(step);
      if (index >= 0) record.steps.splice(index, 1);
      throw error;
    }
  }

  async finish(jobId: string, status: JobEndStatus, error?: JobErrorInfo): Promise<void> {
    const record = this.require(jobId);
    record.status = status;
    record.updatedAt = this.now().toISOString();
    record.resumable = status === "interrupted";
    if (error) record.error = error;
    else delete record.error;
    this.prune();
    await this.persist();
  }

  get(jobId: string): JobRecord | undefined {
    const record = this.records.get(jobId);
    return record ? structuredClone(record) : undefined;
  }

  list(filter: { deviceId?: string; status?: JobStatus } = {}): JobRecord[] {
    return [...this.records.values()]
      .filter((r) => (filter.deviceId ? r.deviceId === filter.deviceId : true))
      .filter((r) => (filter.status ? r.status === filter.status : true))
      .map((r) => structuredClone(r));
  }

  async close(): Promise<void> {
    await this.chain.catch(() => undefined);
    this.opened = false;
  }

  private assertOpen(): void {
    if (!this.opened) throw new Error("El diario de trabajos no está abierto.");
  }

  private require(jobId: string): JobRecord {
    this.assertOpen();
    const record = this.records.get(jobId);
    if (!record) throw new Error(`No existe el trabajo ${jobId} en el diario.`);
    return record;
  }

  private prune(): void {
    const finished = [...this.records.values()]
      .filter((r) => r.status === "done" || r.status === "failed")
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const excess = finished.length - this.keepFinished;
    for (let i = 0; i < excess; i += 1) this.records.delete(finished[i].id);
  }

  /** Las escrituras van en fila: nunca dos a la vez sobre el mismo archivo. */
  private persist(): Promise<void> {
    const snapshot = [...this.records.values()].map((r) => structuredClone(r));
    const next = this.chain.catch(() => undefined).then(() => this.storage.save(snapshot));
    this.chain = next;
    return next;
  }
}
