import { AGENT_URL } from "../../sale/printer-agent";

/**
 * Balanza Kretz Report por CABLE DE RED (Ethernet), a través del programa de Patagonia en la PC
 * (public/patagonia-print-agent.ps1, el mismo de la impresora, desde su versión 4).
 *
 * Por qué así: Chrome no puede abrir una conexión TCP. El programa la abre y pasa los bytes tal cual; acá se arma un
 * objeto con la misma forma que un puerto serie de Chrome (open/close/readable/writable), así TODO el protocolo
 * Kretz que ya anda por Bluetooth y USB (scale-serial.ts, discovery.ts) se usa sin cambiar una línea.
 *
 * Real Oliem minimarket (29/10/2026): Report LT "RPL NP30P2CAR" con el cable de red directo a la placa de red de la
 * PC, sin Bluetooth. Manual Kretz Report NX/LT: menú Configuración de Red = NRO BALANZA, IP y PUERTO (1001).
 */

export interface NetAddress {
  host: string;
  port: number;
}

/** Puerto de fábrica de la Report por red (manual "Report NX / LT", Configuración de Red). */
export const KRETZ_NET_PORT = 1001;
/** Versión del programa de la PC que trae el puente a la red. */
export const NET_AGENT_VERSION = 4;

export interface LocalAddress {
  name: string;
  kind: string;
  ip: string;
  mask: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Solo para pruebas: un programa de la PC simulado. */
export function setNetAgentFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}

async function agentCall<T>(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<{ status: number; body: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(AGENT_URL + path, { ...init, signal: controller.signal });
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ── Direcciones ─────────────────────────────────────────────────────────────────────────────────────────

function ipBytes(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x >= 0 && x <= 255) ? b : null;
}

/** Una dirección de la red local (lo único que acepta el programa de la PC: nunca internet). */
export function isLocalNetworkHost(host: string): boolean {
  const b = ipBytes(host);
  if (!b) return false;
  return b[0] === 10 || (b[0] === 172 && b[1] >= 16 && b[1] <= 31) || (b[0] === 192 && b[1] === 168) || (b[0] === 169 && b[1] === 254);
}

/** ¿La balanza está en la misma red que alguna placa de la PC? Si no, la PC no llega a ella sin configurar algo. */
export function sameSubnet(host: string, local: Pick<LocalAddress, "ip" | "mask">[]): boolean {
  const h = ipBytes(host);
  if (!h) return false;
  return local.some((l) => {
    const ip = ipBytes(l.ip);
    const mask = ipBytes(l.mask);
    return !!ip && !!mask && ip.every((x, i) => (x & mask[i]) === (h[i] & mask[i]));
  });
}

export function netKey(a: NetAddress): string {
  return `red:${a.host}:${a.port}`;
}

export function parseNetKey(key: string | null | undefined): NetAddress | null {
  const m = /^red:([\d.]+):(\d+)$/.exec(key ?? "");
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

const ADDRESSES_KEY = "patagonia-scale-net-addresses";

/** Las balanzas por red que se conectaron alguna vez desde ESTA computadora. */
export function knownNetAddresses(): NetAddress[] {
  try {
    const raw = localStorage.getItem(ADDRESSES_KEY);
    const list = raw ? (JSON.parse(raw) as NetAddress[]) : [];
    return list.filter((a) => isLocalNetworkHost(a.host) && Number.isInteger(a.port));
  } catch {
    return [];
  }
}

export function rememberNetAddress(a: NetAddress): void {
  try {
    const list = knownNetAddresses().filter((x) => netKey(x) !== netKey(a));
    localStorage.setItem(ADDRESSES_KEY, JSON.stringify([a, ...list].slice(0, 8)));
  } catch {
    // sin localStorage: la próxima vez se escribe la dirección de nuevo
  }
}

// ── El "puerto" por red ─────────────────────────────────────────────────────────────────────────────────

type ReadResult = { value: Uint8Array | undefined; done: boolean };

function fromBase64(b64: string): Uint8Array {
  if (!b64) return new Uint8Array();
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Misma forma que un SerialPort de Chrome, para el código Kretz de siempre:
 * - open(): el programa de la PC abre la conexión con la balanza (la velocidad no aplica a la red);
 * - writable.getWriter().write(): manda la trama tal cual;
 * - readable.getReader().read(): espera lo que conteste la balanza (lo que llega después de soltar el lector queda
 *   guardado para la próxima lectura, como en un puerto serie).
 */
export class NetScalePort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  connected = true;
  /** Lo que llegó y todavía nadie leyó. */
  private buffered: number[] = [];
  private generation = 0;

  constructor(readonly net: NetAddress) {}

  getInfo(): SerialPortInfo {
    return {};
  }

  async setSignals(): Promise<void> {
    // no aplica a la red
  }

  async open(_options?: SerialOptions): Promise<void> {
    if (this.readable) {
      const err = new Error("La conexión con la balanza ya estaba abierta.");
      err.name = "InvalidStateError";
      throw err;
    }
    let r: { status: number; body: { ok?: boolean; error?: string; local?: LocalAddress[] } };
    try {
      r = await agentCall(`/scale/open?host=${encodeURIComponent(this.net.host)}&port=${this.net.port}`, { method: "POST" });
    } catch (err) {
      throw netError("sin_programa", "El programa de Patagonia no está funcionando en esta computadora.", err);
    }
    if (!r.body.ok) throw netError("sin_conexion", r.body.error ?? `La balanza no contesta en ${this.net.host}.`, null, r.body.local);
    this.generation++;
    this.buffered = [];
    const gen = this.generation;
    this.readable = this.makeReadable(gen) as unknown as ReadableStream<Uint8Array>;
    this.writable = this.makeWritable(gen) as unknown as WritableStream<Uint8Array>;
  }

  async close(): Promise<void> {
    this.generation++;
    this.readable = null;
    this.writable = null;
    this.buffered = [];
    try {
      await agentCall("/scale/close", { method: "POST" }, 3000);
    } catch {
      // el programa no está: no hay nada abierto
    }
  }

  private makeWritable(gen: number) {
    const port = this;
    const stream = {
      locked: false,
      getWriter() {
        stream.locked = true;
        return {
          async write(chunk: Uint8Array) {
            if (gen !== port.generation) throw closedError();
            const r = await agentCall<{ ok?: boolean; error?: string; closed?: boolean }>("/scale/write", {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: new Blob([chunk as unknown as BlobPart])
            });
            if (!r.body.ok) {
              if (r.body.closed) port.lost(gen);
              throw closedError(r.body.error);
            }
          },
          releaseLock() {
            stream.locked = false;
          },
          async close() {
            stream.locked = false;
          }
        };
      }
    };
    return stream;
  }

  private makeReadable(gen: number) {
    const port = this;
    const stream = {
      locked: false,
      getReader() {
        stream.locked = true;
        let released = false;
        let waiting: ((r: ReadResult) => void) | null = null;
        return {
          read(): Promise<ReadResult> {
            if (port.buffered.length) {
              const value = new Uint8Array(port.buffered);
              port.buffered = [];
              return Promise.resolve({ value, done: false });
            }
            return new Promise<ReadResult>((resolve, reject) => {
              waiting = resolve;
              void (async () => {
                // Se pregunta de a poco (200 ms) hasta que llegue algo, se suelte el lector o se cierre.
                while (!released && gen === port.generation) {
                  let r: { status: number; body: { ok?: boolean; data?: string; closed?: boolean; error?: string } };
                  try {
                    r = await agentCall("/scale/read?ms=200", { method: "POST" }, 5000);
                  } catch (err) {
                    if (released || gen !== port.generation) break;
                    port.lost(gen);
                    reject(closedError(err instanceof Error ? err.message : String(err)));
                    return;
                  }
                  if (gen !== port.generation) break;
                  // Todo lo que llega va al buffer (también lo que trajo una lectura de un lector ya soltado).
                  port.buffered.push(...fromBase64(r.body.data ?? ""));
                  if (released) return;
                  if (port.buffered.length) {
                    const value = new Uint8Array(port.buffered);
                    port.buffered = [];
                    waiting = null;
                    resolve({ value, done: false });
                    return;
                  }
                  if (!r.body.ok || r.body.closed) {
                    port.lost(gen);
                    if (!released) reject(closedError(r.body.error));
                    return;
                  }
                }
                waiting?.({ value: undefined, done: gen !== port.generation });
              })();
            });
          },
          releaseLock() {
            released = true;
            stream.locked = false;
            // Una lectura pendiente termina sin datos (lo que llegue queda guardado para la próxima).
            const w = waiting;
            waiting = null;
            w?.({ value: undefined, done: false });
          },
          async cancel() {
            this.releaseLock();
          }
        };
      }
    };
    return stream;
  }

  /** La balanza cortó la conexión: queda como un puerto cerrado (el próximo open la vuelve a abrir). */
  private lost(gen: number) {
    if (gen !== this.generation) return;
    this.generation++;
    this.readable = null;
    this.writable = null;
  }
}

function closedError(detail?: string): Error {
  const err = new Error(detail ? `Se cortó la conexión con la balanza por la red (${detail}).` : "Se cortó la conexión con la balanza por la red.");
  err.name = "RedError";
  return err;
}

export type NetErrorKind = "sin_programa" | "sin_conexion";

function netError(kind: NetErrorKind, message: string, cause: unknown, local?: LocalAddress[]): Error {
  const err = new Error(message);
  err.name = "RedError";
  return Object.assign(err, { netKind: kind, local: local ?? null, cause });
}

export function netErrorInfo(err: unknown): { kind: NetErrorKind; local: LocalAddress[] | null } | null {
  const e = err as { netKind?: NetErrorKind; local?: LocalAddress[] | null } | null;
  return e?.netKind ? { kind: e.netKind, local: e.local ?? null } : null;
}

const ports = new Map<string, NetScalePort>();

/** Siempre el mismo objeto para la misma dirección (la búsqueda y el envío lo reconocen por identidad). */
export function netPortFor(a: NetAddress): NetScalePort {
  const key = netKey(a);
  let p = ports.get(key);
  if (!p) {
    p = new NetScalePort(a);
    ports.set(key, p);
  }
  return p;
}

export function isNetPort(port: unknown): port is NetScalePort {
  return port instanceof NetScalePort;
}

// ── El programa de la PC ────────────────────────────────────────────────────────────────────────────────

/** Versión del programa de la PC, o null si no está corriendo (o Chrome no deja hablarle). */
export async function netAgentVersion(): Promise<number | null> {
  try {
    const r = await agentCall<{ ok?: boolean; version?: number }>("/ping", undefined, 6000);
    return r.body.ok ? Number(r.body.version ?? 0) : null;
  } catch {
    return null;
  }
}

/** Busca balanzas en la red de esta PC (las que aceptan conexión en ese puerto) y devuelve también sus placas. */
export async function findNetScales(port = KRETZ_NET_PORT): Promise<{ found: string[]; local: LocalAddress[] }> {
  const r = await agentCall<{ ok?: boolean; found?: string[]; local?: LocalAddress[] }>(`/scale/find?port=${port}`, undefined, 20000);
  return { found: r.body.found ?? [], local: r.body.local ?? [] };
}

/** ¿La PC llega a la balanza en esa dirección? Abre y cierra (no le manda nada). */
export async function testNetScale(a: NetAddress): Promise<{ ok: true } | { ok: false; message: string; local: LocalAddress[] | null; kind: NetErrorKind }> {
  const port = new NetScalePort(a);
  try {
    await port.open();
    await port.close();
    return { ok: true };
  } catch (err) {
    const info = netErrorInfo(err);
    return { ok: false, message: err instanceof Error ? err.message : String(err), local: info?.local ?? null, kind: info?.kind ?? "sin_conexion" };
  }
}
