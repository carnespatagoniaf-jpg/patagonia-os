// Costura entre la nube y los protocolos. El canal con la nube (cloud-agent.ts) toma un trabajo y se lo da a un
// JobExecutor. El de verdad es ScaleJobExecutor (src/scales/scale-executor.ts, sobre ScaleProtocolHost); acá están los
// tipos y un ejecutor que dice "todavía no sé hacerlo" (sin protocolos) para no dejar trabajos colgados.

import type { CloudConfig } from "./cloud-client";

/** Un trabajo tal como lo entrega scale-connect-api /claim (migración 226). */
export interface CloudJob {
  id: string;
  kind: "send" | "test" | "read";
  /** La balanza: scale_key de la base (la misma que el conector informa en el latido). */
  scaleKey: string;
  branchId: string | null;
  requested: number;
  /** Lo que hay que mandar, armado en la web o el servidor: {"products": [{product_id, plu, name, price, ...}], ...}. */
  payload: Record<string, unknown>;
  queuedAt: string | null;
}

/** Resultado de un producto (misma forma que scale_job_items de la migración 220). */
export interface JobItemResult {
  product_id?: string | null;
  plu?: string | null;
  action: "write" | "replace" | "delete" | "read" | "verify";
  status: "confirmed" | "failed" | "skipped" | "pending";
  reason?: string | null;
  sent?: Record<string, unknown> | null;
  read_back?: Record<string, unknown> | null;
}

export interface JobProgress {
  done: number;
  total: number;
  text?: string;
  /** Productos que quedaron resueltos desde el último aviso (se guardan en la nube enseguida). */
  items?: JobItemResult[];
}

export interface JobOutcome {
  status: "done" | "partial" | "failed";
  /** Productos que no se informaron en un aviso de avance. */
  items?: JobItemResult[];
  counters?: { requested?: number; confirmed?: number; failed?: number; skipped?: number };
  /** Código corto del error, si lo hubo (hasta 80 caracteres): "no_contesta", "puerto_ocupado"… */
  errorCode?: string | null;
}

/** Lo que el trabajo puede pedirle a la nube con la credencial de esta PC (sin verla). */
export interface JobCloud {
  /** scale-connect-api/engine con este trabajo (migración 227). Rechaza si la nube dice que no. */
  engine(action: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Las balanzas de la sucursal y en qué puerto de esta PC está cada una. */
  config(): Promise<CloudConfig>;
}

export interface JobContext {
  /** Se dispara si el servicio se apaga o la PC fue desvinculada: hay que cortar prolijo y devolver lo hecho. */
  signal: AbortSignal;
  /** Informa avance. Nunca rechaza: si la nube no contesta, los productos viajan con el cierre. */
  progress(update: JobProgress): Promise<void>;
  /** Puede faltar (pruebas): entonces el ejecutor trabaja sin la nube. */
  cloud?: JobCloud;
}

export interface JobExecutor {
  execute(job: CloudJob, context: JobContext): Promise<JobOutcome>;
}

/** Mientras no estén los protocolos: cierra el trabajo como fallido, con un motivo claro. */
export class UnavailableExecutor implements JobExecutor {
  async execute(): Promise<JobOutcome> {
    return { status: "failed", errorCode: "sin_protocolo", items: [] };
  }
}
