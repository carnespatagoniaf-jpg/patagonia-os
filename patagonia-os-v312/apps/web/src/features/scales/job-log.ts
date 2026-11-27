import { logScaleActivity } from "./activity-log";
import type { EngineProduct, PreparedSync, SyncOutcome } from "./engine/types";

/**
 * Historial de envíos a las balanzas (migración 215, C18): cada "PASAR PRODUCTOS" de Mis balanzas, bueno o malo,
 * queda en scale_jobs + scale_job_items con el resultado por producto.
 *
 * Reglas:
 * - Registrar NUNCA frena ni demora el envío: start va en paralelo y finish después, sin await en el camino del envío.
 * - Si falla (sin conexión, sin permiso, error de la base), queda en la bitácora local (activity-log.ts) y no se
 *   muestra nada.
 * - Si la base todavía no tiene la migración 215 (función inexistente), se ignora en silencio.
 *
 * Qué trae la sesión del motor (SyncOutcome de los adaptadores Kretz/Systel): `verified` (cuántos quedaron
 * releídos iguales, sin la lista), `failures` (cada producto que no quedó, con motivo), `pending` (lo que quedó para
 * revisar, p. ej. un número ocupado por otro producto) y `support` (detalle técnico). Lo que no va a la balanza
 * (sin precio, código largo…) viene en `prepared.skipped`. Por eso los confirmados se cuentan y no se listan uno por uno.
 *
 * Sin dependencias de Supabase: quien llama pasa `rpc` (support-service.ts → scaleJobRpc). Probado en job-log.test.ts.
 */

export type ScaleJobRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;

export type ScaleJobStatus = "done" | "partial" | "failed";

export interface ScaleJobItem {
  product_id: string | null;
  plu: string | null;
  action: "write" | "replace" | "delete" | "read" | "verify";
  status: "confirmed" | "failed" | "skipped" | "pending";
  reason: string | null;
  sent: { name: string; price: number } | null;
  read_back: Record<string, unknown> | null;
}

export interface ScaleJobResult {
  status: ScaleJobStatus;
  counters: { requested: number; confirmed: number; failed: number; skipped: number };
  items: ScaleJobItem[];
  errorCode: string | null;
}

/** Topes de la migración 215. */
export const MAX_JOB_ITEMS = 10000;
const MAX_REASON = 300;
const MAX_DETAIL_CHARS = 30000;

const clamp = (n: number) => Math.max(0, Math.min(MAX_JOB_ITEMS, Math.round(Number.isFinite(n) ? n : 0)));
const cut = (s: string | null | undefined, max: number) => (s ? s.slice(0, max) : null);

/** Códigos tal como los muestra la balanza ("0037" = 37): el producto de Patagonia con ese código. */
function productFor(products: EngineProduct[], code: string): EngineProduct | undefined {
  return products.find((p) => p.code === code) ?? (/^\d+$/.test(code) ? products.find((p) => /^\d+$/.test(p.code) && Number(p.code) === Number(code)) : undefined);
}

function item(products: EngineProduct[], code: string, action: ScaleJobItem["action"], status: ScaleJobItem["status"], reason: string | null): ScaleJobItem {
  const p = productFor(products, code);
  return {
    product_id: p?.id ?? null,
    plu: cut(code, 40),
    action,
    status,
    reason: cut(reason, MAX_REASON),
    sent: p ? { name: p.name.slice(0, 120), price: p.priceRetail } : null,
    read_back: null
  };
}

/**
 * Resultado de un envío para el historial. `outcome` null = el envío tiró un error (no hubo resultado); entonces
 * `error` dice cuál.
 */
export function buildSendJobResult(input: {
  prepared: PreparedSync;
  outcome: SyncOutcome | null;
  products: EngineProduct[];
  /** Cuántos productos se pidió escribir (los cambios + los ocupados si se autorizó reemplazarlos). */
  requested: number;
  replace: boolean;
  error?: string | null;
}): ScaleJobResult {
  const { prepared, outcome, products } = input;
  const items: ScaleJobItem[] = [];
  for (const f of outcome?.failures ?? []) items.push(item(products, f.code, "write", "failed", f.reason));
  for (const s of prepared.skipped ?? []) items.push(item(products, s.code, "write", "skipped", s.reason));
  for (const p of outcome?.pending ?? (outcome ? [] : prepared.pending)) {
    items.push(item(products, String(p.code), p.reason === "ocupado_en_balanza" ? "replace" : "write", "pending", `${p.reason}: ${p.detail}`));
  }
  const confirmed = outcome?.verified ?? 0;
  const failed = outcome ? (outcome.ok ? (outcome.failures?.length ?? 0) : Math.max(outcome.failures?.length ?? 0, 1)) : Math.max(input.requested - confirmed, 1);
  const status: ScaleJobStatus = outcome?.ok && failed === 0 ? "done" : confirmed > 0 ? "partial" : "failed";
  const support = outcome?.support as { etapa?: unknown; verdict?: unknown } | undefined;
  const errorCode = status === "done" ? null : cut(input.error ?? String(support?.etapa ?? support?.verdict ?? "frenado"), 80);
  return {
    status,
    counters: { requested: clamp(input.requested), confirmed: clamp(confirmed), failed: clamp(failed), skipped: clamp(prepared.skipped?.length ?? 0) },
    items: items.slice(0, MAX_JOB_ITEMS),
    errorCode
  };
}

/** Detalle del trabajo (jsonb): lo que sirve a soporte, nunca más de ~30 KB. */
export function jobDetail(prepared: PreparedSync, outcome: SyncOutcome | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = { modelo: prepared.label, listos: prepared.ready, cambios: prepared.writes, pendientes: prepared.pending.length, ...extra };
  if (outcome) base.mensaje = outcome.message.slice(0, 300);
  const withSupport = outcome?.support ? { ...base, soporte: outcome.support } : base;
  return JSON.stringify(withSupport).length <= MAX_DETAIL_CHARS ? withSupport : base;
}

/** La base no tiene la migración 215 (o PostgREST todavía no la ve). */
export function isMissingFunction(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

function noteLocally(scaleKey: string, text: string): void {
  logScaleActivity({ kind: "sync", connectionLabel: scaleKey, message: `Historial de envíos: ${text}`.slice(0, 500) });
}

export interface StartedJob {
  /** Id del trabajo en la base, o null si no se pudo registrar (sin conexión, sin la 215…). */
  id: Promise<string | null>;
  scaleKey: string;
}

/** Abre el trabajo en la base sin esperar (el envío sigue en paralelo). Nunca tira error. */
export function startScaleJob(rpc: ScaleJobRpc | null, input: { branchId: string; scaleKey: string; kind: "send" | "test" | "read"; requested: number; appVersion: string | null; detail?: Record<string, unknown> }): StartedJob {
  const id = (async (): Promise<string | null> => {
    if (!rpc) return null;
    try {
      const { data, error } = await rpc("start_scale_job", {
        p_branch_id: input.branchId,
        p_scale_key: input.scaleKey.slice(0, 120),
        p_kind: input.kind,
        p_source: "web",
        p_requested: clamp(input.requested),
        p_app_version: input.appVersion ? input.appVersion.slice(0, 80) : null,
        p_detail: input.detail ?? {}
      });
      if (error) {
        if (!isMissingFunction(error)) noteLocally(input.scaleKey, `no se pudo registrar el inicio (${error.message ?? error.code ?? "error"})`);
        return null;
      }
      return typeof data === "string" ? data : null;
    } catch (err) {
      noteLocally(input.scaleKey, `no se pudo registrar el inicio (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
  })();
  return { id, scaleKey: input.scaleKey };
}

/** Cierra el trabajo con su resultado. Nunca tira error; si no se pudo, lo anota en la bitácora local. */
export async function finishScaleJob(rpc: ScaleJobRpc | null, job: StartedJob, result: ScaleJobResult): Promise<boolean> {
  const summary = `${result.status}: ${result.counters.confirmed} confirmados, ${result.counters.failed} con problemas, ${result.counters.skipped} salteados de ${result.counters.requested}${result.errorCode ? ` (${result.errorCode})` : ""}`;
  const id = await job.id;
  if (!rpc || !id) {
    noteLocally(job.scaleKey, `envío sin registrar en la base · ${summary}`);
    return false;
  }
  try {
    const { error } = await rpc("finish_scale_job", { p_job_id: id, p_status: result.status, p_counters: result.counters, p_items: result.items, p_error: result.errorCode });
    if (error) {
      noteLocally(job.scaleKey, `no se pudo registrar el resultado (${error.message ?? error.code ?? "error"}) · ${summary}`);
      return false;
    }
    return true;
  } catch (err) {
    noteLocally(job.scaleKey, `no se pudo registrar el resultado (${err instanceof Error ? err.message : String(err)}) · ${summary}`);
    return false;
  }
}
