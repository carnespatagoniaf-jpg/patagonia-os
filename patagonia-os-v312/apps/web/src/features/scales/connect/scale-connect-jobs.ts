/**
 * Mis balanzas por Patagonia Scale Connect (migraciones 226 y 227): lógica pura, sin Supabase (la base se inyecta con
 * `ScaleConnectPort`; la de verdad está en scale-connect-jobs-service.ts). La usa ScaleConnectFlow.tsx y la prueba de
 * punta a punta del conector (apps/connector/src/scales/end-to-end.test.ts).
 *
 *   Enviar productos → si la balanza está en una PC con Scale Connect en línea (latido de menos de 2 minutos), se
 *   encola el envío con los MISMOS productos que hoy arma la pantalla, y se consulta el avance cada 2 s hasta que
 *   termina. El resultado sale con los mismos textos que el envío por cable ("X de Y quedaron y se comprobaron").
 *   Si la PC está apagada: "La computadora Caja 1 está apagada o sin internet". Sin Scale Connect: Web Serial, igual
 *   que siempre.
 *
 *   Agregar balanza → "En esta computadora con Scale Connect": la PC busca las balanzas de sus puertos (solo lectura),
 *   la persona elige cuál, se pregunta "¿Es la misma?" como al agregar por cable, se registra (register_branch_scale)
 *   y se vincula a ese puerto de esa PC (bind_scale_to_connector).
 */

import { sendSummary } from "../my-scale-text";
import type { EngineProduct, ProductProblem } from "../engine/types";

export type ConnectJobStatus = "queued" | "running" | "done" | "partial" | "failed";

/** Huella física del puerto en la PC (la que informa el conector). */
export interface ConnectDevice {
  id: string;
  kind?: "serial" | "tcp";
  fingerprint?: string;
  source?: string;
  path?: string;
  chip?: string;
  host?: string;
  port?: number;
  mac?: string;
}

export interface ConnectComputer {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
}

export interface ConnectBinding {
  scaleKey: string;
  connectorId: string;
  connectorName: string;
  online: boolean;
  device: ConnectDevice | null;
}

export interface ConnectStatus {
  connectors: ConnectComputer[];
  bindings: ConnectBinding[];
}

export interface ConnectJob {
  id: string;
  status: ConnectJobStatus;
  progress: { done: number; total: number; text: string | null } | null;
  errorCode: string | null;
  counters: { requested: number; confirmed: number; failed: number; skipped: number };
}

export interface ConnectJobItem {
  productId: string | null;
  plu: string | null;
  action: string;
  status: "confirmed" | "failed" | "skipped" | "pending";
  reason: string | null;
  sent: Record<string, unknown> | null;
  readBack: Record<string, unknown> | null;
}

/** Lo que la pantalla necesita de la base (inyectable para probar). */
export interface ScaleConnectPort {
  /** null = la base no tiene la migración 227 (sin Scale Connect: todo como antes). */
  status(branchId: string): Promise<ConnectStatus | null>;
  queue(input: { branchId: string; scaleKey: string; kind: "send" | "test" | "read"; payload: Record<string, unknown>; connectorId: string }): Promise<string>;
  job(id: string): Promise<{ job: ConnectJob; items: ConnectJobItem[] } | null>;
  bind(branchId: string, scaleKey: string, connectorId: string | null, device: ConnectDevice | null): Promise<void>;
}

/** La balanza del trabajo "buscar balanzas" (no es una balanza: scale_key fijo). */
export const IDENTIFY_SCALE_KEY = "__buscar-balanzas__";
/** Cada cuánto se consulta el avance. */
export const POLL_MS = 2000;
/** Si en este tiempo la PC no tomó el trabajo, se vuelve a mirar si sigue en línea. */
export const QUEUED_CHECK_MS = 30_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function parseDevice(raw: unknown): ConnectDevice | null {
  if (!isObj(raw) || !str(raw.id)) return null;
  const d: ConnectDevice = { id: str(raw.id)! };
  if (raw.kind === "serial" || raw.kind === "tcp") d.kind = raw.kind;
  for (const k of ["fingerprint", "source", "path", "chip", "host", "mac"] as const) {
    const v = str(raw[k]);
    if (v) d[k] = v;
  }
  if (typeof raw.port === "number") d.port = raw.port;
  return d;
}

/** Lo que devuelve scale_connect_status (jsonb) → tipado. */
export function parseConnectStatus(raw: unknown): ConnectStatus {
  const o = isObj(raw) ? raw : {};
  const connectors = (Array.isArray(o.connectors) ? o.connectors : []).filter(isObj).flatMap((c) =>
    str(c.id) ? [{ id: str(c.id)!, name: str(c.name) ?? "", online: c.online === true, lastSeenAt: str(c.last_seen_at) }] : []
  );
  const bindings = (Array.isArray(o.bindings) ? o.bindings : []).filter(isObj).flatMap((b) =>
    str(b.scale_key) && str(b.connector_id)
      ? [{ scaleKey: str(b.scale_key)!, connectorId: str(b.connector_id)!, connectorName: str(b.connector_name) ?? "", online: b.online === true, device: parseDevice(b.device) }]
      : []
  );
  return { connectors, bindings };
}

export function parseJobRow(raw: unknown): ConnectJob | null {
  if (!isObj(raw) || !str(raw.id)) return null;
  const st = raw.status;
  const status: ConnectJobStatus = st === "queued" || st === "running" || st === "done" || st === "partial" || st === "failed" ? st : "running";
  const p = isObj(raw.progress) ? raw.progress : null;
  return {
    id: str(raw.id)!,
    status,
    progress: p ? { done: num(p.done), total: num(p.total), text: str(p.text) } : null,
    errorCode: str(raw.error_code),
    counters: { requested: num(raw.requested_count), confirmed: num(raw.confirmed_count), failed: num(raw.failed_count), skipped: num(raw.skipped_count) },
  };
}

export function parseJobItems(raw: unknown): ConnectJobItem[] {
  return (Array.isArray(raw) ? raw : []).filter(isObj).map((i) => ({
    productId: str(i.product_id),
    plu: str(i.plu),
    action: str(i.action) ?? "write",
    status: i.status === "confirmed" || i.status === "failed" || i.status === "skipped" ? i.status : "pending",
    reason: str(i.reason),
    sent: isObj(i.sent) ? i.sent : null,
    readBack: isObj(i.read_back) ? i.read_back : null,
  }));
}

export const isFinished = (s: ConnectJobStatus) => s === "done" || s === "partial" || s === "failed";

/** "La computadora Caja 1 está apagada o sin internet". */
export function offlineMessage(computerName: string): string {
  return `La computadora ${computerName || "de la balanza"} está apagada o sin internet. Prendela (o revisá su internet) y probá de nuevo.`;
}

/** ¿Esta balanza va por Scale Connect? null = no (se manda por cable, como siempre). */
export function connectorFor(status: ConnectStatus | null, scaleKey: string): ConnectBinding | null {
  return status?.bindings.find((b) => b.scaleKey === scaleKey) ?? null;
}

/** Las mismas opciones que el envío por cable (MyScale → connectBranchScale) viajan en el trabajo. */
export interface SendOptions {
  allowReplace?: boolean;
  canManageLinks?: boolean;
  weightBarcode?: boolean;
  pesosBarcode?: boolean;
  plu5Barcode?: boolean;
}

/** Productos de la pantalla (los mismos que recibe el envío por cable) → payload de queue_scale_job. */
export function sendPayload(products: EngineProduct[], opts: SendOptions = {}): Record<string, unknown> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    products: products.map((p) => ({
      // queue_scale_job valida que cada product_id sea de la empresa: los de demostración/sin id van sin él.
      ...(uuid.test(p.id) ? { product_id: p.id } : {}),
      plu: p.code,
      name: p.name,
      unit: p.unit,
      price: p.priceRetail,
      active: p.active !== false,
    })),
    allow_replace: opts.allowReplace === true,
    can_manage_links: opts.canManageLinks !== false,
    weight_barcode: opts.weightBarcode === true,
    pesos_barcode: opts.pesosBarcode === true,
    plu5_barcode: opts.plu5Barcode === true,
  };
}

export interface JobWatch {
  /** Cada consulta (para la barra de avance). */
  onProgress?: (job: ConnectJob) => void;
  pollMs?: number;
  queuedCheckMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type JobRun =
  | { kind: "terminado"; job: ConnectJob; items: ConnectJobItem[] }
  | { kind: "apagada"; message: string; jobId: string }
  | { kind: "cancelado"; jobId: string };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Encola y espera: consulta el trabajo cada `pollMs` hasta que termina. Si la PC no lo toma en `queuedCheckMs`, se
 * vuelve a mirar su latido: si dejó de estar en línea, "está apagada o sin internet" (el trabajo queda en cola y la PC
 * lo hace cuando vuelve, o la nube lo da por vencido al día).
 */
export async function runConnectorJob(
  port: ScaleConnectPort,
  input: { branchId: string; scaleKey: string; kind: "send" | "test" | "read"; payload: Record<string, unknown>; connector: ConnectComputer | ConnectBinding },
  watch: JobWatch = {}
): Promise<JobRun> {
  const sleep = watch.sleep ?? defaultSleep;
  const now = watch.now ?? Date.now;
  const connectorId = "connectorId" in input.connector ? input.connector.connectorId : input.connector.id;
  const connectorName = "connectorName" in input.connector ? input.connector.connectorName : input.connector.name;
  const jobId = await port.queue({ branchId: input.branchId, scaleKey: input.scaleKey, kind: input.kind, payload: input.payload, connectorId });
  const started = now();
  let lastCheck = started;
  for (;;) {
    if (watch.signal?.aborted) return { kind: "cancelado", jobId };
    await sleep(watch.pollMs ?? POLL_MS);
    if (watch.signal?.aborted) return { kind: "cancelado", jobId };
    let current: Awaited<ReturnType<ScaleConnectPort["job"]>> = null;
    try {
      current = await port.job(jobId);
    } catch {
      continue; // sin conexión un momento: se vuelve a consultar
    }
    if (!current) continue;
    watch.onProgress?.(current.job);
    if (isFinished(current.job.status)) return { kind: "terminado", job: current.job, items: current.items };
    if (current.job.status === "queued" && now() - lastCheck >= (watch.queuedCheckMs ?? QUEUED_CHECK_MS)) {
      lastCheck = now();
      const status = await port.status(input.branchId).catch(() => null);
      const pc = status?.connectors.find((c) => c.id === connectorId);
      if (status && (!pc || !pc.online)) return { kind: "apagada", message: offlineMessage(connectorName), jobId };
    }
  }
}

export interface SendResultView {
  ok: boolean;
  /** Productos que quedaron y se comprobaron releyendo la balanza. */
  confirmed: number;
  /** "X de Y productos quedaron y se comprobaron en la balanza." */
  headline: string;
  next: string[];
  /** Lo que dijo la balanza (el mismo mensaje del envío por cable). */
  message: string;
  failures: ProductProblem[];
  skipped: ProductProblem[];
}

/** El resultado del envío por Scale Connect, con los mismos textos que el envío por cable (my-scale-text.ts). */
export function sendResultView(job: ConnectJob, items: ConnectJobItem[], products: EngineProduct[]): SendResultView {
  const byCode = new Map(products.map((p) => [p.code, p]));
  const problem = (i: ConnectJobItem): ProductProblem => ({ code: i.plu ?? "", name: byCode.get(i.plu ?? "")?.name ?? "", reason: i.reason ?? "" });
  const confirmed = items.filter((i) => i.status === "confirmed").length;
  const failures = items.filter((i) => i.status === "failed").map(problem);
  const skipped = items.filter((i) => i.status === "skipped").map(problem);
  const summary = sendSummary({ ready: 0, verified: confirmed, failed: failures.length, skipped: skipped.length, toReview: 0, occupied: 0 });
  const message = job.progress?.text ?? (job.status === "done" ? "Listo." : "No se pudo terminar el envío.");
  return { ok: job.status === "done" && failures.length === 0, confirmed, headline: summary.headline, next: summary.next, message, failures, skipped };
}

/** Una balanza que encontró la PC al buscar (trabajo "identify"). */
export interface FoundScale {
  deviceId: string;
  name: string;
  device: ConnectDevice;
  family: "kretz" | "systel";
  model: string | null;
  label: string;
  identity: Record<string, unknown>;
}

export function foundScales(items: ConnectJobItem[]): FoundScale[] {
  return items.flatMap((i) => {
    const rb = i.readBack;
    const device = parseDevice(i.sent);
    const family = rb?.family;
    if (i.status !== "confirmed" || !rb || !device || (family !== "kretz" && family !== "systel")) return [];
    return [
      {
        deviceId: str(rb.device_id) ?? device.id,
        name: str(rb.name) ?? str(rb.label) ?? device.id,
        device,
        family,
        model: str(rb.model),
        label: str(rb.label) ?? (family === "kretz" ? "Kretz" : "Systel"),
        identity: isObj(rb.identity) ? rb.identity : {},
      },
    ];
  });
}

/** Dónde está: "COM3", "red 192.168.0.50". */
export function whereText(d: ConnectDevice): string {
  if (d.kind === "tcp" || d.host) return `por red ${d.host ?? ""}`.trim();
  return d.path ? `en ${d.path}` : "";
}

/** Puertos de las balanzas por red: Kretz Report/NX (1001) y Systel con módulo de red (10001). */
const NET_SCALE_PORTS = [1001, 10001];

/**
 * Qué direcciones de red le pide buscar la web a Scale Connect: las que escribió la persona (con comas, puntos de más
 * o espacios, como en el asistente de red) más las que esta PC ya usó. Solo IP de red local (el servicio igual rechaza
 * cualquier otra); máximo 5 direcciones, cada una en los dos puertos.
 */
export function identifyNetwork(typed: string[], known: string[] = []): Array<{ host: string; port: number }> {
  const clean = (t: string) => t.trim().replace(/\s*[,;]\s*|\s*\.\s*|\s+/g, ".");
  const ok = (ip: string) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!m || m.slice(1).some((x) => Number(x) > 255)) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  };
  const ips = [...new Set([...typed.map(clean), ...known.map(clean)])].filter(ok).slice(0, 5);
  return ips.flatMap((host) => NET_SCALE_PORTS.map((port) => ({ host, port })));
}
