// Cliente HTTPS de las Edge Functions scale-connect-pair y scale-connect-api (migración 226).
// Solo conexiones salientes. El secreto viaja únicamente en el encabezado x-scale-connector y solo por HTTPS
// (o a 127.0.0.1 en pruebas): nunca se manda a una dirección http:// de afuera.

import type { CloudJob, JobItemResult } from "./job-executor";

export const CONNECTOR_HEADER = "x-scale-connector";

export type CloudErrorKind =
  | "network" // sin conexión, DNS, tiempo agotado
  | "unauthorized" // 401: credencial inválida (borrada o inventada)
  | "revoked" // 403: el dueño desvinculó esta PC
  | "not_found" // 404
  | "conflict" // 409: el trabajo ya estaba cerrado
  | "rate_limited" // 429
  | "bad_request" // 400 / 413
  | "server"; // 5xx o respuesta rara

export class CloudError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "CloudError";
  }

  /** La PC tiene que volver a vincularse. */
  get needsPairing(): boolean {
    return this.kind === "unauthorized" || this.kind === "revoked";
  }
}

export interface Credential {
  connectorId: string;
  secret: string;
}

/** Huella física del puerto donde está la balanza en esta PC (migración 227). */
export interface ScaleDevice {
  /** Id local estable del puerto en esta PC (no cambia si Windows le cambia el número de COM). */
  id: string;
  kind: "serial" | "tcp";
  /** Serie real del adaptador USB o su ubicación física (discovery/port-classify). */
  fingerprint?: string;
  source?: string;
  path?: string;
  chip?: string;
  host?: string;
  port?: number;
  mac?: string;
}

export interface SeenScale {
  /** scale_key de la base si la web ya la vinculó; si no, "dev:<id del puerto>". */
  key: string;
  name: string;
  online: boolean;
  device?: ScaleDevice;
  family?: "kretz" | "systel";
  model?: string;
  label?: string;
  identity?: Record<string, unknown>;
}

export interface PairRequest {
  code: string;
  name: string;
  fingerprint: string | null;
  version: string;
  recoverId?: string | null;
  forceNew?: boolean;
}

export type PairResult =
  | { kind: "paired"; connectorId: string; secret: string; name: string; branchId: string | null; recovered: boolean }
  | { kind: "choose"; candidates: Array<{ id: string; name: string; lastSeenAt: string | null }> }
  | { kind: "error"; error: string };

export interface HeartbeatResult {
  name: string | null;
  branchId: string | null;
  queued: number;
}

export interface CloudScaleConfig {
  key: string;
  name: string | null;
  family: string | null;
  brand: string | null;
  model: string | null;
  identity: unknown;
  active: boolean | null;
  /** En qué puerto de ESTA PC está (la web la vinculó); null = no está en esta PC. */
  device: ScaleDevice | null;
}

export interface CloudConfig {
  connector: { id: string; name: string; branchId: string | null };
  companyName: string | null;
  branchName: string | null;
  scales: CloudScaleConfig[];
  /** Versión que la nube le ofrece a esta PC (migración 229), o null. Solo despierta al actualizador: él verifica todo. */
  updateVersion?: string | null;
}

/** Oferta de actualización (ruta /update, migración 229). Del servidor solo sirve el manifiesto firmado. */
export interface UpdateOffer {
  channel: "pilot" | "stable";
  offer: { version: string; manifest: unknown } | null;
}

export interface CloudClientOptions {
  /** Base de las funciones: https://<proyecto>.supabase.co/functions/v1 */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Tiempo máximo de un pedido común (el de la consulta larga se calcula aparte). */
  timeoutMs?: number;
  userAgent?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function isSafeCloudUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

function kindForStatus(status: number): CloudErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "revoked";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 413 || status === 422) return "bad_request";
  return "server";
}

export function parseDevice(raw: unknown): ScaleDevice | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const device: ScaleDevice = { id, kind: raw.kind === "tcp" ? "tcp" : "serial" };
  for (const k of ["fingerprint", "source", "path", "chip", "host", "mac"] as const) {
    const v = str(raw[k]);
    if (v) device[k] = v;
  }
  if (typeof raw.port === "number") device.port = raw.port;
  return device;
}

export function parseJob(raw: unknown): CloudJob | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const kind = raw.kind;
  const scaleKey = str(raw.scale_key);
  if (!id || !scaleKey || (kind !== "send" && kind !== "test" && kind !== "read")) return null;
  return {
    id,
    kind,
    scaleKey,
    branchId: str(raw.branch_id),
    requested: typeof raw.requested === "number" ? raw.requested : 0,
    payload: isObj(raw.payload) ? raw.payload : {},
    queuedAt: str(raw.queued_at),
  };
}

export class CloudClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: CloudClientOptions) {
    if (!isSafeCloudUrl(options.baseUrl)) throw new Error(`Dirección de la nube inválida (tiene que ser https): ${options.baseUrl}`);
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.userAgent = options.userAgent ?? "PatagoniaScaleConnect";
  }

  private async post(path: string, body: unknown, options: { credential?: Credential; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ status: number; body: Obj }> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": this.userAgent };
    if (options.credential) headers[CONNECTOR_HEADER] = `${options.credential.connectorId}.${options.credential.secret}`;
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}/${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}), signal, redirect: "error" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CloudError("network", `Sin conexión con Patagonia: ${message}`);
    }
    let parsed: Obj = {};
    try {
      const text = await res.text();
      const value = text ? JSON.parse(text) : {};
      parsed = isObj(value) ? value : {};
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed };
  }

  private async api(route: string, credential: Credential, body: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Obj> {
    const { status, body: result } = await this.post(`scale-connect-api/${route}`, body, { ...options, credential });
    if (status >= 200 && status < 300) return result;
    const message = str(result.message) ?? str(result.error) ?? `HTTP ${status}`;
    throw new CloudError(kindForStatus(status), message, status, result);
  }

  async pair(request: PairRequest): Promise<PairResult> {
    const { status, body } = await this.post("scale-connect-pair", {
      code: request.code,
      name: request.name,
      fingerprint: request.fingerprint,
      version: request.version,
      recover_id: request.recoverId ?? null,
      force_new: request.forceNew === true,
    });
    if (status === 200 && body.ok === true) {
      const connectorId = str(body.connector_id);
      const secret = str(body.secret);
      if (!connectorId || !secret) throw new CloudError("server", "Respuesta de vinculación incompleta", status);
      return { kind: "paired", connectorId, secret, name: str(body.name) ?? request.name, branchId: str(body.branch_id), recovered: body.recovered === true };
    }
    if (body.error === "elegir" && Array.isArray(body.candidates)) {
      return {
        kind: "choose",
        candidates: body.candidates.filter(isObj).map((c) => ({ id: str(c.id) ?? "", name: str(c.name) ?? "", lastSeenAt: str(c.last_seen_at) })).filter((c) => c.id),
      };
    }
    if (status >= 500) throw new CloudError("server", `Patagonia respondió ${status}`, status);
    return { kind: "error", error: str(body.error) ?? `http_${status}` };
  }

  async heartbeat(credential: Credential, input: { version: string; scales: SeenScale[] }, signal?: AbortSignal): Promise<HeartbeatResult> {
    const r = await this.api("heartbeat", credential, { version: input.version, scales: input.scales.slice(0, 50) }, { signal });
    return { name: str(r.name), branchId: str(r.branch_id), queued: typeof r.queued === "number" ? r.queued : 0 };
  }

  /** Consulta larga: la función espera hasta `waitSec` a que aparezca un trabajo. */
  async claim(credential: Credential, waitSec: number, signal?: AbortSignal): Promise<CloudJob | null> {
    const wait = Math.max(0, Math.min(25, Math.floor(waitSec)));
    const r = await this.api("claim", credential, { wait }, { timeoutMs: wait * 1000 + 15_000, signal });
    if (r.job === null || r.job === undefined) return null;
    const job = parseJob(r.job);
    if (!job) throw new CloudError("server", "Trabajo con formato desconocido");
    return job;
  }

  async progress(
    credential: Credential,
    input: { jobId: string; seq: number; done: number; total: number; text?: string | null; items: JobItemResult[] },
    signal?: AbortSignal,
  ): Promise<{ duplicate: boolean }> {
    const r = await this.api(
      "progress",
      credential,
      { job_id: input.jobId, seq: input.seq, done: input.done, total: input.total, text: input.text ?? null, items: input.items },
      { signal },
    );
    return { duplicate: r.duplicate === true };
  }

  async finish(
    credential: Credential,
    input: { jobId: string; status: "done" | "partial" | "failed"; counters?: Obj; items: JobItemResult[]; error?: string | null },
    signal?: AbortSignal,
  ): Promise<Obj> {
    const r = await this.api(
      "finish",
      credential,
      { job_id: input.jobId, status: input.status, counters: input.counters ?? {}, items: input.items, error: input.error ?? null },
      { timeoutMs: 60_000, signal },
    );
    return isObj(r.result) ? r.result : {};
  }

  /**
   * Lo que el motor de "Mi balanza" le pide a Patagonia durante un trabajo en curso (migración 227): leer el formato
   * de etiqueta y el catálogo de la sucursal del trabajo, y escribir por las RPC de la web en nombre de quien encoló.
   */
  async engine(credential: Credential, input: { jobId: string; action: string; args?: Obj }, signal?: AbortSignal): Promise<Obj> {
    return this.api("engine", credential, { job_id: input.jobId, action: input.action, args: input.args ?? {} }, { timeoutMs: 60_000, signal });
  }

  async config(credential: Credential, signal?: AbortSignal): Promise<CloudConfig> {
    const r = await this.api("config", credential, {}, { signal });
    const c = isObj(r.connector) ? r.connector : {};
    return {
      connector: { id: str(c.id) ?? credential.connectorId, name: str(c.name) ?? "", branchId: str(c.branch_id) },
      companyName: str(r.company_name),
      branchName: str(r.branch_name),
      scales: (Array.isArray(r.scales) ? r.scales : []).filter(isObj).map((s) => ({
        key: str(s.key) ?? "",
        name: str(s.name),
        family: str(s.family),
        brand: str(s.brand),
        model: str(s.model),
        identity: s.identity ?? null,
        active: typeof s.active === "boolean" ? s.active : null,
        device: parseDevice(s.device),
      })),
      updateVersion: isObj(r.update) ? str(r.update.version) : null,
    };
  }

  /** Qué versión le toca a esta PC (canal de la empresa + porcentaje de despliegue). La llama el actualizador. */
  async updateOffer(credential: Credential, currentVersion: string, signal?: AbortSignal): Promise<UpdateOffer> {
    const r = await this.api("update", credential, { current_version: currentVersion }, { signal });
    const offer = isObj(r.offer) ? r.offer : null;
    const version = offer ? str(offer.version) : null;
    return {
      channel: r.channel === "pilot" ? "pilot" : "stable",
      offer: offer && version && isObj(offer.manifest) ? { version, manifest: offer.manifest } : null,
    };
  }

  /** Resultado de una actualización (instalada, revertida, rechazada…). */
  async reportUpdate(credential: Credential, report: Obj, signal?: AbortSignal): Promise<void> {
    await this.api("update-report", credential, report, { signal });
  }
}
