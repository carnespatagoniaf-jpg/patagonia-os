// Lógica pura de scale-connect-pair y scale-connect-api (sin Deno ni Supabase), probada desde
// apps/web/src/features/scales/scale-connect-server.test.ts (el repo no corre tests de Deno).
//
// Lo que hace cada parte:
// - Credencial del conector: encabezado `x-scale-connector: <id>.<secreto>`. El secreto (32 bytes al azar en
//   base64url) lo genera scale-connect-pair, lo devuelve UNA vez y a la base solo va su SHA-256.
// - Validar y acotar cada pedido antes de llamar a la base (tamaño, campos, listas).
// - Traducir los errores de la base (SQLSTATE PTxxx de la migración 226) a códigos HTTP.

export const CONNECTOR_HEADER = "x-scale-connector";

/** Topes de tamaño de los cuerpos, por ruta. */
export const MAX_PAIR_BODY = 4 * 1024;
export const MAX_SMALL_BODY = 64 * 1024;
export const MAX_FINISH_BODY = 4 * 1024 * 1024;
export const MAX_PROGRESS_BODY = 1024 * 1024;

/** Consulta larga: hasta 25 s esperando un trabajo, preguntando a la base cada 2,5 s. */
export const LONG_POLL_MAX_SEC = 25;
export const LONG_POLL_STEP_MS = 2500;

export const MAX_ITEMS_PER_PROGRESS = 2000;
export const MAX_ITEMS_PER_FINISH = 10000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

// ------------------------------------------------------------------------------------------------ cripto
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Secreto del conector: 32 bytes al azar (256 bits) en base64url, 43 caracteres. */
export function generateSecret(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return toBase64Url(random(new Uint8Array(32)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------------------------------------ credencial
export interface ConnectorCredential {
  id: string;
  secret: string;
}

export function parseConnectorCredential(header: string | null | undefined): ConnectorCredential | null {
  if (!header) return null;
  const value = header.trim();
  if (value.length > 200) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot).toLowerCase();
  const secret = value.slice(dot + 1);
  if (!UUID.test(id) || !SECRET.test(secret)) return null;
  return { id, secret };
}

export function formatConnectorCredential(credential: ConnectorCredential): string {
  return `${credential.id}.${credential.secret}`;
}

// ------------------------------------------------------------------------------------------------ código
/** Saca espacios y guiones, y pasa a mayúsculas. "abcd-efgh" → "ABCDEFGH". */
export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

export function isPairingCodeFormat(code: string): boolean {
  return code.length === 8 && [...code].every((c) => CODE_ALPHABET.includes(c));
}

/** Para mostrar: "ABCD-EFGH". */
export function formatPairingCode(code: string): string {
  const c = normalizePairingCode(code);
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

// ------------------------------------------------------------------------------------------------ cuerpos
/**
 * Solo `Content-Type: application/json` (el conector siempre lo manda). Un navegador no puede mandar ese tipo a otro
 * dominio sin pasar la consulta previa de CORS, que estas funciones no contestan: así una página cualquiera no puede
 * usar los navegadores de sus visitas para probar códigos de vinculación desde miles de direcciones.
 */
export function isJsonRequest(headers: { get(name: string): string | null }): boolean {
  const type = (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return type === "application/json";
}

/** Lee el cuerpo con tope: corta por Content-Length y por lo que llega de verdad. */
export async function readJsonLimited(req: Request, max: number): Promise<Parsed<unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return bad("muy_grande");
  if (!req.body) return bad("sin_cuerpo");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return bad("muy_grande");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(all)) };
  } catch {
    return bad("json_invalido");
  }
}

const shortText = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

export interface PairRequest {
  code: string;
  name: string;
  fingerprintHash: string | null;
  version: string | null;
  recoverId: string | null;
  forceNew: boolean;
}

export function parsePairRequest(body: unknown): Parsed<PairRequest> {
  if (!isObj(body)) return bad("datos_invalidos");
  const code = typeof body.code === "string" ? normalizePairingCode(body.code) : "";
  if (!code) return bad("falta_codigo");
  if (code.length > 20) return bad("codigo_invalido");
  const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
  if (name.length > 40) return bad("nombre_invalido");
  let fingerprintHash: string | null = null;
  if (body.fingerprint !== undefined && body.fingerprint !== null) {
    if (typeof body.fingerprint !== "string" || !HEX64.test(body.fingerprint)) return bad("huella_invalida");
    fingerprintHash = body.fingerprint;
  }
  let recoverId: string | null = null;
  if (body.recover_id !== undefined && body.recover_id !== null) {
    if (typeof body.recover_id !== "string" || !UUID.test(body.recover_id)) return bad("datos_invalidos");
    recoverId = body.recover_id.toLowerCase();
  }
  if (!recoverId && !name) return bad("nombre_invalido");
  return {
    ok: true,
    value: { code, name, fingerprintHash, version: shortText(body.version, 40), recoverId, forceNew: body.force_new === true },
  };
}

/** Quién pide (para frenar a quien prueba códigos): la primera IP de x-forwarded-for, o la que haya. */
export function clientAddress(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return (first || headers.get("cf-connecting-ip") || headers.get("x-real-ip") || "desconocido").slice(0, 100);
}

/** Respuesta HTTP de un canje: 200 bien; 409 hay que elegir ("¿Es Caja 1?"); 429 frenado; 400 el resto. */
export function pairStatus(result: { ok?: boolean; error?: string }): number {
  if (result.ok) return 200;
  if (result.error === "elegir") return 409;
  if (result.error === "demasiados_intentos") return 429;
  return 400;
}

// ------------------------------------------------------------------------------------------------ api
export type ApiRoute = "claim" | "progress" | "finish" | "heartbeat" | "config" | "engine";
const ROUTES: readonly ApiRoute[] = ["claim", "progress", "finish", "heartbeat", "config", "engine"];

/** ".../functions/v1/scale-connect-api/claim" → "claim". */
export function apiRoute(pathname: string): ApiRoute | null {
  const last = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  return (ROUTES as readonly string[]).includes(last) ? (last as ApiRoute) : null;
}

export function maxBodyFor(route: ApiRoute): number {
  if (route === "finish") return MAX_FINISH_BODY;
  if (route === "progress" || route === "engine") return MAX_PROGRESS_BODY;
  return MAX_SMALL_BODY;
}

export function parseClaimRequest(body: unknown): Parsed<{ waitSec: number }> {
  if (body !== undefined && body !== null && !isObj(body)) return bad("datos_invalidos");
  const raw = isObj(body) ? body.wait : undefined;
  const wait = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return { ok: true, value: { waitSec: Math.max(0, Math.min(LONG_POLL_MAX_SEC, wait)) } };
}

/** Huella física del puerto donde la PC ve la balanza (migración 227). La base la vuelve a limpiar. */
export interface SeenDevice {
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

export interface SeenScale {
  key: string;
  name: string;
  online: boolean;
  device?: SeenDevice;
  family?: "kretz" | "systel";
  model?: string;
  label?: string;
  identity?: Record<string, unknown>;
}

function parseDevice(raw: unknown): SeenDevice | undefined {
  if (!isObj(raw)) return undefined;
  const id = shortText(raw.id, 80);
  if (!id) return undefined;
  const d: SeenDevice = { id };
  if (raw.kind === "serial" || raw.kind === "tcp") d.kind = raw.kind;
  for (const [k, max] of [["fingerprint", 200], ["source", 20], ["path", 20], ["chip", 40], ["host", 60], ["mac", 20]] as const) {
    const v = shortText(raw[k], max);
    if (v) d[k] = v;
  }
  const port = int(raw.port, 1, 65535);
  if (port !== null) d.port = port;
  return d;
}

export function parseHeartbeatRequest(body: unknown): Parsed<{ version: string | null; scales: SeenScale[] }> {
  if (!isObj(body)) return bad("datos_invalidos");
  const list = body.scales === undefined ? [] : body.scales;
  if (!Array.isArray(list) || list.length > 50) return bad("balanzas_invalidas");
  const scales: SeenScale[] = [];
  for (const s of list) {
    if (!isObj(s)) continue;
    const key = shortText(s.key, 120);
    if (!key) continue;
    const scale: SeenScale = { key, name: shortText(s.name, 60) ?? key, online: s.online === true };
    const device = parseDevice(s.device);
    if (device) scale.device = device;
    if (s.family === "kretz" || s.family === "systel") scale.family = s.family;
    const model = shortText(s.model, 40);
    if (model) scale.model = model;
    const label = shortText(s.label, 60);
    if (label) scale.label = label;
    if (isObj(s.identity) && JSON.stringify(s.identity).length <= 300) scale.identity = s.identity;
    scales.push(scale);
  }
  return { ok: true, value: { version: shortText(body.version, 40), scales } };
}

function parseItems(raw: unknown, max: number): Parsed<Obj[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return bad("productos_invalidos");
  if (raw.length > max) return bad("demasiados_productos");
  if (!raw.every(isObj)) return bad("productos_invalidos");
  return { ok: true, value: raw as Obj[] };
}

export interface ProgressRequest {
  jobId: string;
  seq: number;
  done: number;
  total: number;
  text: string | null;
  items: Obj[];
}

export function parseProgressRequest(body: unknown): Parsed<ProgressRequest> {
  if (!isObj(body)) return bad("datos_invalidos");
  if (typeof body.job_id !== "string" || !UUID.test(body.job_id)) return bad("trabajo_invalido");
  const seq = int(body.seq, 1, 1_000_000);
  if (seq === null) return bad("secuencia_invalida");
  const items = parseItems(body.items, MAX_ITEMS_PER_PROGRESS);
  if (!items.ok) return items;
  return {
    ok: true,
    value: {
      jobId: body.job_id.toLowerCase(),
      seq,
      done: int(body.done, 0, 10000) ?? 0,
      total: int(body.total, 0, 10000) ?? 0,
      text: shortText(body.text, 200),
      items: items.value,
    },
  };
}

export interface FinishRequest {
  jobId: string;
  status: "done" | "partial" | "failed";
  counters: Obj;
  items: Obj[];
  error: string | null;
}

export function parseFinishRequest(body: unknown): Parsed<FinishRequest> {
  if (!isObj(body)) return bad("datos_invalidos");
  if (typeof body.job_id !== "string" || !UUID.test(body.job_id)) return bad("trabajo_invalido");
  const status = body.status;
  if (status !== "done" && status !== "partial" && status !== "failed") return bad("estado_invalido");
  const counters: Obj = {};
  if (body.counters !== undefined && body.counters !== null) {
    if (!isObj(body.counters)) return bad("contadores_invalidos");
    for (const k of ["requested", "confirmed", "failed", "skipped"]) {
      if (body.counters[k] === undefined) continue;
      const v = int(body.counters[k], 0, 10000);
      if (v === null) return bad("contadores_invalidos");
      counters[k] = v;
    }
  }
  const items = parseItems(body.items, MAX_ITEMS_PER_FINISH);
  if (!items.ok) return items;
  return { ok: true, value: { jobId: body.job_id.toLowerCase(), status, counters, items: items.value, error: shortText(body.error, 80) } };
}

// ------------------------------------------------------------------------------------------------ motor
/** Lo que el motor de "Mi balanza" del conector le pide a Patagonia durante un trabajo (migración 227). */
export const ENGINE_ACTIONS = [
  "load_branch_config",
  "list_branch_scales",
  "load_scale_setup",
  "save_branch_config",
  "save_scale_catalog",
  "set_scale_links",
  "set_scale_profile_active",
  "report",
] as const;
export type EngineAction = (typeof ENGINE_ACTIONS)[number];

export interface EngineRequest {
  jobId: string;
  action: EngineAction;
  args: Obj;
}

export function parseEngineRequest(body: unknown): Parsed<EngineRequest> {
  if (!isObj(body)) return bad("datos_invalidos");
  if (typeof body.job_id !== "string" || !UUID.test(body.job_id)) return bad("trabajo_invalido");
  if (typeof body.action !== "string" || !(ENGINE_ACTIONS as readonly string[]).includes(body.action)) return bad("accion_invalida");
  const args = body.args === undefined || body.args === null ? {} : body.args;
  if (!isObj(args)) return bad("datos_invalidos");
  return { ok: true, value: { jobId: body.job_id.toLowerCase(), action: body.action as EngineAction, args } };
}

// ------------------------------------------------------------------------------------------------ errores
/** SQLSTATE de la base → HTTP. PTxxx = los de la migración 226; P0001 = validación (raise exception común). */
export function rpcErrorStatus(code: string | undefined | null): number {
  const m = /^PT(\d{3})$/.exec(code ?? "");
  if (m) return Number(m[1]);
  if (code === "P0001" || code === "22P02" || code === "23514") return 400;
  return 500;
}

/** El mensaje que se devuelve: para 5xx nunca el detalle interno de la base. */
export function rpcErrorBody(error: { code?: string; message?: string } | null | undefined): { ok: false; error: string; message?: string } {
  const status = rpcErrorStatus(error?.code);
  if (status >= 500) return { ok: false, error: "error_interno" };
  const name: Record<number, string> = { 400: "datos_invalidos", 401: "credencial_invalida", 403: "revocado", 404: "no_existe", 409: "cerrado", 429: "demasiados_pedidos" };
  return { ok: false, error: name[status] ?? "error", message: (error?.message ?? "").slice(0, 200) };
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Respuesta JSON sin CORS: estas funciones las llama el servicio de Windows, nunca un navegador. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: SECURITY_HEADERS });
}
