import { buildSystelFrame, describeSystelError, parseSystelReply, toHex, type SystelReply } from "./systel-frame";
import {
  buildNewPluData,
  buildPriceChangeData,
  detectPluLayouts,
  diffPlu,
  expectedAfterPriceChange,
  expectedReadOfNew,
  LAYOUT_INFO,
  parseConfig,
  parsePing,
  parsePluList,
  parseSignature,
  readPluRequest,
  type NewPluInput,
  type PluField,
  type PluListEntry,
  type SystelLayout,
  type SystelPlu,
  type SystelSignature
} from "./systel-plu";

/**
 * Cliente Systel (Cuora 2 / Cuora Max). Seguridad primero:
 * - Solo se pueden mandar las funciones de LECTURA de la lista blanca, más 33
 *   (cambio de precio), 61/4 (escribir un PLU) a través de `changePrice` y
 *   `createPlu`, que releen y comparan después de escribir.
 * - Nunca: 5 (borrar PLU), 9 (borrar sector: borra sus PLU), 26 (apagar),
 *   32 (cierre de ventas), 42 (decimales) ni ninguna de configuración.
 * - `createPlu` solo escribe en un número que NO está en la balanza.
 * - Una escritura sin respuesta nunca se reenvía a ciegas: primero se relee.
 */

export interface SystelLink {
  /** Manda una trama y devuelve lo que llegue hasta que la línea quede en silencio (null si no llegó nada). */
  exchange(frame: Uint8Array, options: { timeoutMs: number; quietMs?: number }): Promise<Uint8Array | null>;
}

export const SYSTEL_READ_FUNCTIONS = [1, 2, 3, 23, 28, 31, 39, 62] as const;
export const SYSTEL_WRITE_FUNCTIONS = [4, 33, 61] as const;
export const SYSTEL_FORBIDDEN_FUNCTIONS = [5, 6, 7, 8, 9, 10, 12, 13, 15, 16, 17, 18, 22, 24, 25, 26, 32, 34, 35, 38, 40, 41, 42, 45, 46, 47, 64, 65, 68, 69, 70, 71, 74, 87];

const WRITE_TOKEN = Symbol("systel-write");

export function assertSystelFunctionAllowed(fn: number, token?: symbol): void {
  if ((SYSTEL_READ_FUNCTIONS as readonly number[]).includes(fn)) return;
  if ((SYSTEL_WRITE_FUNCTIONS as readonly number[]).includes(fn) && token === WRITE_TOKEN) return;
  throw new Error(`Bloqueado: Patagonia no manda la función ${fn} a una balanza Systel.`);
}

export interface SystelExchangeLog {
  step: string;
  fn: number;
  tx: string;
  rx: string;
  rxText: string;
  ms: number;
  result: string;
}

export interface SystelClientOptions {
  /** Número de "Identificación" de la balanza (menú 11 → 3 → 1). */
  address: number;
  timeoutMs?: number;
  /** La función 61/4 se documenta SIN verificación; las demás con. HIPÓTESIS: se prueba "con" y, si contesta E5, "sin". */
  writeChecksum?: "con" | "sin";
  log?: SystelExchangeLog[];
}

export class SystelError extends Error {
  constructor(message: string, readonly reply: SystelReply | null) {
    super(message);
    this.name = "SystelError";
  }
}

export class SystelClient {
  readonly address: number;
  readonly log: SystelExchangeLog[];
  private readonly timeoutMs: number;
  writeChecksum: "con" | "sin";

  constructor(private readonly link: SystelLink, options: SystelClientOptions) {
    this.address = options.address;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.writeChecksum = options.writeChecksum ?? "con";
    this.log = options.log ?? [];
  }

  /** Manda una función y devuelve la respuesta validada (dirección, función y verificación). */
  private async call(step: string, fn: number, data: string, opts: { token?: symbol; checksum?: boolean; timeoutMs?: number } = {}): Promise<SystelReply | null> {
    assertSystelFunctionAllowed(fn, opts.token);
    const frame = buildSystelFrame(this.address, fn, data, { checksum: opts.checksum });
    const t0 = Date.now();
    const rx = await this.link.exchange(frame, { timeoutMs: opts.timeoutMs ?? this.timeoutMs });
    const reply = rx ? parseSystelReply(rx) : null;
    const valid = !!reply && reply.checksumOk && reply.address === this.address && reply.fn === fn;
    this.log.push({
      step,
      fn,
      tx: toHex(frame),
      rx: rx ? toHex(rx) : "",
      rxText: reply ? reply.data.replace(/[^\x20-\x7e]/g, ".") : "",
      ms: Date.now() - t0,
      result: !rx ? "sin respuesta" : !reply ? "respuesta ilegible" : !valid ? "respuesta con otra dirección/función o verificación mal" : reply.kind
    });
    return valid ? reply : null;
  }

  async signature(): Promise<SystelSignature | null> {
    const r = await this.call("firma digital", 2, "");
    return r && r.kind === "data" ? parseSignature(r.data) : null;
  }

  async ping(): Promise<{ state: "T" | "D" | "S" } | null> {
    const r = await this.call("ping", 23, "");
    return r && r.kind === "data" ? parsePing(r.data) : null;
  }

  async config(): Promise<{ raw: string; values: Record<string, string> } | null> {
    const r = await this.call("configuración completa", 39, "");
    return r && r.kind === "data" ? { raw: r.data, values: parseConfig(r.data) } : null;
  }

  async list(): Promise<{ entries: PluListEntry[]; digits: 4 | 6 | null } | null> {
    const r = await this.call("lista de PLU", 31, "", { timeoutMs: Math.max(this.timeoutMs, 15000) });
    if (!r || r.kind !== "data") return null;
    const parsed = parsePluList(r.data);
    return parsed ? { entries: parsed.entries, digits: parsed.digits } : null;
  }

  /**
   * Reconoce el formato leyendo un PLU que existe. Con números de 4 dígitos prueba
   * primero la 62 (Cuora Max V6.0) y, si la balanza no la conoce (E4), la 3 (Cuora 2).
   */
  async detectLayout(existing: number, digits: 4 | 6): Promise<{ layout: SystelLayout; plu: SystelPlu } | { layout: null; detail: string }> {
    const tries: { fn: number; layouts: SystelLayout[] }[] = digits === 6 ? [{ fn: 62, layouts: ["max62", "max7"] }] : [{ fn: 62, layouts: ["max60"] }, { fn: 3, layouts: ["cuora2"] }];
    const details: string[] = [];
    for (const t of tries) {
      const r = await this.call(`reconocer formato (función ${t.fn})`, t.fn, String(existing).padStart(digits, "0"));
      if (!r) {
        details.push(`función ${t.fn}: sin respuesta válida`);
        continue;
      }
      if (r.kind === "error") {
        details.push(`función ${t.fn}: ${describeSystelError(r.errorCode)}`);
        continue;
      }
      const matches = detectPluLayouts(r.data, existing, t.layouts);
      if (matches.length === 1) return { layout: matches[0].layout, plu: matches[0] };
      details.push(`función ${t.fn}: ${matches.length === 0 ? `respuesta de ${r.data.length} caracteres que no encaja con ningún formato documentado` : "encaja con más de un formato"}`);
    }
    return { layout: null, detail: details.join("; ") };
  }

  async readPlu(layout: SystelLayout, number: number): Promise<SystelPlu | null> {
    const info = LAYOUT_INFO[layout];
    const r = await this.call(`leer PLU ${number}`, info.readFn, readPluRequest(layout, number));
    if (!r || r.kind !== "data") return null;
    return detectPluLayouts(r.data, number, [layout])[0] ?? null;
  }

  /**
   * Cambia SOLO el precio de la lista 1 (función 33) y relee para comprobar que todo lo demás quedó igual.
   * `current` tiene que ser una lectura reciente de ese PLU.
   */
  async changePrice(current: SystelPlu, newPriceRaw: number): Promise<WriteOutcome> {
    const data = buildPriceChangeData(current, newPriceRaw);
    const expected = expectedAfterPriceChange(current, newPriceRaw);
    const r = await this.call(`cambiar precio PLU ${current.number}`, 33, data, { token: WRITE_TOKEN });
    return this.confirmWrite(current.layout, current.number, r, expected, current);
  }

  /**
   * Escribe un PLU NUEVO (función 61, o 4 en Cuora 2). `knownNumbers` es la lista
   * leída recién: si el número ya existe, no escribe.
   */
  async createPlu(layout: SystelLayout, input: NewPluInput, knownNumbers: Set<number>): Promise<WriteOutcome> {
    if (knownNumbers.has(input.number)) return { ok: false, verdict: "ocupado", detail: `el PLU ${input.number} ya existe en la balanza: no se escribe encima`, readBack: null, diff: [] };
    const fresh = await this.readPlu(layout, input.number);
    if (fresh) return { ok: false, verdict: "ocupado", detail: `el PLU ${input.number} ya existe en la balanza: no se escribe encima`, readBack: fresh, diff: [] };
    const data = buildNewPluData(layout, input);
    const expected = expectedReadOfNew(layout, input);
    const fn = LAYOUT_INFO[layout].writeFn;
    let r = await this.call(`crear PLU ${input.number}`, fn, data, { token: WRITE_TOKEN, checksum: this.writeChecksum === "con" });
    if (r?.kind === "error" && r.errorCode === "E5") {
      // E5 = largo incorrecto: la balanza no guardó nada. Se prueba la otra forma documentada (con/sin verificación).
      this.writeChecksum = this.writeChecksum === "con" ? "sin" : "con";
      r = await this.call(`crear PLU ${input.number} (${this.writeChecksum} verificación)`, fn, data, { token: WRITE_TOKEN, checksum: this.writeChecksum === "con" });
    }
    return this.confirmWrite(layout, input.number, r, expected, null);
  }

  private async confirmWrite(layout: SystelLayout, number: number, reply: SystelReply | null, expected: Omit<SystelPlu, "managedBy" | "raw">, before: SystelPlu | null): Promise<WriteOutcome> {
    if (reply && reply.kind === "error") {
      return { ok: false, verdict: "rechazada", detail: `la balanza rechazó el PLU ${number} (${describeSystelError(reply.errorCode)})`, readBack: null, diff: [] };
    }
    // Sin ACK (o sin respuesta): no se reenvía a ciegas. Se relee para saber qué pasó.
    const back = await this.readPlu(layout, number);
    if (!back) return { ok: false, verdict: "sin_relectura", detail: `no se pudo releer el PLU ${number} después de escribirlo`, readBack: null, diff: [] };
    const diff = diffPlu(expected, back);
    if (diff.length === 0) return { ok: true, verdict: reply && reply.kind === "ack" ? "confirmado" : "confirmado_sin_ack", detail: "", readBack: back, diff };
    if (before && diffPlu(expectedAfterPriceChange(before, before.prices[0]), back).length === 0) {
      return { ok: false, verdict: "sin_cambios", detail: `el PLU ${number} quedó como estaba (la balanza no aplicó el cambio)`, readBack: back, diff };
    }
    return { ok: false, verdict: "diferencia", detail: `el PLU ${number} volvió distinto en: ${diff.join(", ")}`, readBack: back, diff };
  }
}

export interface WriteOutcome {
  ok: boolean;
  verdict: "confirmado" | "confirmado_sin_ack" | "rechazada" | "ocupado" | "sin_relectura" | "sin_cambios" | "diferencia";
  detail: string;
  readBack: SystelPlu | null;
  diff: PluField[];
}
