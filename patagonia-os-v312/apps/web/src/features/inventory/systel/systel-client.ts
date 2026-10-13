import { buildSystelFrame, describeSystelError, findSystelReplies, parseSystelReply, toHex, type SystelReply } from "./systel-frame";
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
  exchange(frame: Uint8Array, options: SystelExchangeOptions): Promise<Uint8Array | null>;
}

export interface SystelExchangeOptions {
  timeoutMs: number;
  quietMs?: number;
  /**
   * Si lo que llegó todavía no es una trama completa (verificación mal), se sigue esperando
   * aunque la línea haga una pausa. Real 2026-10-09 (Los gringos): la lista de PLU llegó
   * cortada en el 503 porque la balanza hizo una pausa de más de 60 ms a mitad de respuesta.
   */
  isComplete?: (rx: Uint8Array) => boolean;
}

/** La respuesta termina en un byte de verificación correcto: si no, es que falta algo. */
export function replyIsComplete(rx: Uint8Array): boolean {
  const r = parseSystelReply(rx);
  return !!r && r.checksumOk;
}

/** Errores de transmisión: la balanza no hizo la orden, se puede volver a pedir. */
const TRANSIENT_ERRORS = new Set(["E1", "E2", "E3"]);

export const SYSTEL_READ_FUNCTIONS = [1, 2, 3, 23, 28, 31, 39, 62] as const;
/**
 * Escrituras posibles, cada una solo a través de su método (que relee y compara):
 * 33 cambio de precio, 61/4 alta, 7 SOLO para "imprimir el código de barras en los tickets"
 * (setTicketBarcodes: el otro parámetro de la 7 va con "X" = "el parámetro permanece sin cambio").
 */
export const SYSTEL_WRITE_FUNCTIONS = [4, 7, 33, 61] as const;
export const SYSTEL_FORBIDDEN_FUNCTIONS = [5, 6, 8, 9, 10, 12, 13, 15, 16, 17, 18, 22, 24, 25, 26, 32, 34, 35, 38, 40, 41, 42, 45, 46, 47, 64, 65, 68, 69, 70, 71, 74, 87];

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
  /** Esperas entre reintentos de una lectura cuando la balanza contesta E1/E2/E3. */
  busyRetryMs?: number[];
  /**
   * Byte de control en el ALTA (61/4). Por defecto "con": la regla general del documento (V6.0 pág. 3,
   * "Trama de transmisión PC-Balanza: … Verificación") lo incluye en toda trama; cuando Systel quiere
   * decir lo contrario lo aclara (función 87: "Esta función no tiene en cuenta el CRC", pág. 30) y para
   * la 61 no lo aclara; la V4.0 lo pone en la función 4 (pág. 8) y el ejemplo oficial lo agrega siempre.
   * "sin_experimental" existe SOLO para la herramienta de laboratorio (balanza de banco) y nunca se
   * prueba sola: ya no hay reintento automático con la otra forma.
   */
  createChecksum?: "con" | "sin_experimental";
  log?: SystelExchangeLog[];
  /**
   * Escrituras habilitadas POR OPERACIÓN (bloqueadas por defecto, decisión del dueño 2026-10-09).
   * Que una funcione no habilita la otra: en producción salen de SYSTEL_VERIFIED_WRITE_PROFILES
   * (por firma + formato + operación), hoy vacío.
   */
  writes?: { price?: boolean; create?: boolean; ticketBarcodes?: boolean };
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
  private readonly busyRetryMs: number[];
  private readonly createChecksum: "con" | "sin_experimental";
  private readonly writes: { price: boolean; create: boolean; ticketBarcodes: boolean };

  constructor(private readonly link: SystelLink, options: SystelClientOptions) {
    this.address = options.address;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.createChecksum = options.createChecksum ?? "con";
    this.log = options.log ?? [];
    this.writes = { price: options.writes?.price === true, create: options.writes?.create === true, ticketBarcodes: options.writes?.ticketBarcodes === true };
    this.busyRetryMs = options.busyRetryMs ?? [300, 800, 1500, 3000, 5000];
  }

  /**
   * Manda una función y devuelve la respuesta validada (dirección, función y verificación).
   * En las LECTURAS, ante E1/E2/E3 (la balanza dice que no hizo la orden) se repite la secuencia
   * de arranque comprobada (`wake`) y se reintenta. Las escrituras no se reintentan acá: el cliente
   * relee antes de volver a mandar.
   */
  private async call(step: string, fn: number, data: string, opts: { token?: symbol; checksum?: boolean; timeoutMs?: number } = {}): Promise<SystelReply | null> {
    const isRead = (SYSTEL_READ_FUNCTIONS as readonly number[]).includes(fn);
    let reply = await this.callOnce(step, fn, data, opts);
    for (const wait of isRead ? this.busyRetryMs : []) {
      if (!(reply && reply.kind === "error" && TRANSIENT_ERRORS.has(reply.errorCode ?? ""))) break;
      await new Promise((r) => setTimeout(r, wait));
      await this.wake();
      reply = await this.callOnce(`${step} (reintento)`, fn, data, opts);
    }
    return reply;
  }

  /**
   * Secuencia de arranque COMPROBADA en la balanza real (Los gringos, 2026-10-09 16:08): ping al
   * número 1 y ping general (0) antes de hablarle a su número. Con esa secuencia contestó bien todo;
   * en las 3 sesiones en que se le habló directo a su número contestó E3 a todo (HIPÓTESIS sobre
   * la causa; ver docs/SYSTEL_DIAGNOSTICO_LOS_GRINGOS.md). Solo función 23 (lectura).
   * Devuelve el número que contestó al ping general, si contestó.
   */
  async wake(): Promise<number | null> {
    if (this.address !== 1) await this.rawCall("arranque: ping al 1", 1, 23, "", 350);
    const r = await this.rawCall("arranque: ping general (0)", 0, 23, "", 350);
    return r && r.checksumOk && r.fn === 23 && r.address >= 1 && r.address <= 99 ? r.address : null;
  }

  private callOnce(step: string, fn: number, data: string, opts: { token?: symbol; checksum?: boolean; timeoutMs?: number }): Promise<SystelReply | null> {
    assertSystelFunctionAllowed(fn, opts.token);
    return this.rawCall(step, this.address, fn, data, opts.timeoutMs ?? this.timeoutMs, opts.checksum);
  }

  /**
   * Manda una orden YA AUTORIZADA (la llaman `callOnce`, que controla la lista blanca, y `wake`,
   * que solo manda la 23). Con 0 (general) la balanza contesta con su propio número.
   */
  private async rawCall(step: string, address: number, fn: number, data: string, timeoutMs: number, checksum?: boolean): Promise<SystelReply | null> {
    const frame = buildSystelFrame(address, fn, data, { checksum });
    const t0 = Date.now();
    // Correspondencia con ESTA orden: misma dirección (o una de 1-99 si se preguntó a la general),
    // misma función, control correcto y UNA sola trama posible. El contenido lo verifica después quien
    // lo interpreta (el número de PLU en la 62, el formato en 2/23/31/39, ACK o En en las escrituras).
    const want = address === 0 ? null : address;
    const rx = await this.link.exchange(frame, { timeoutMs, isComplete: (b) => findSystelReplies(b, want, fn).length > 0 });
    const candidates = rx ? findSystelReplies(rx, want, fn) : [];
    const reply = candidates.length === 1 ? candidates[0].reply : null;
    const loose = rx ? parseSystelReply(rx) : null;
    const prefix = reply && candidates[0].start > 0 ? ` · ${candidates[0].start} bytes previos que no son de esta orden` : "";
    this.log.push({
      step,
      fn,
      tx: toHex(frame),
      rx: rx ? toHex(rx) : "",
      rxText: (reply ?? loose)?.data.replace(/[^\x20-\x7e]/g, ".") ?? "",
      ms: Date.now() - t0,
      result: !rx
        ? "sin respuesta"
        : candidates.length > 1
          ? `AMBIGUA: ${candidates.length} tramas válidas para esta orden (una puede ser de una orden anterior); no se usa`
          : !reply
            ? loose ? "respuesta con otra dirección/función o verificación mal" : "respuesta ilegible"
            : reply.kind + prefix
    });
    return reply;
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
   * Función 7, "Configuraciones generales del equipo": 2 letras, "Permitir sumas en modo etiqueta"
   * y "Imprimir el código de barras en los tickets", cada una S/N u "otro valor = el parámetro
   * permanece sin cambio". Igual en los 4 protocolos (V4.0 págs. 16-17, V6.0 17-18, V6.2 y V7 15).
   * Se manda "X" en la primera (no se toca) y S/N en la segunda. Devuelve la respuesta tal cual
   * (ACK, En o null): esto solo no confirma nada, quien llama relee la configuración (39) y compara.
   */
  async setTicketBarcodes(on: boolean): Promise<SystelReply | null | "bloqueado"> {
    if (!this.writes.ticketBarcodes) return "bloqueado";
    return this.call(`imprimir código por producto en tickets = ${on ? "SI" : "NO"} (función 7)`, 7, `X${on ? "S" : "N"}`, { token: WRITE_TOKEN });
  }

  /**
   * Cambia SOLO el precio de la lista 1 (función 33) y relee para comprobar que todo lo demás quedó igual.
   * `current` tiene que ser una lectura reciente de ese PLU.
   */
  async changePrice(current: SystelPlu, newPriceRaw: number): Promise<WriteOutcome> {
    if (!this.writes.price) return BLOCKED;
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
    if (!this.writes.create) return BLOCKED;
    if (knownNumbers.has(input.number)) return { ok: false, verdict: "ocupado", detail: `el PLU ${input.number} ya existe en la balanza: no se escribe encima`, readBack: null, diff: [] };
    const fresh = await this.readPlu(layout, input.number);
    if (fresh) return { ok: false, verdict: "ocupado", detail: `el PLU ${input.number} ya existe en la balanza: no se escribe encima`, readBack: fresh, diff: [] };
    const data = buildNewPluData(layout, input);
    const expected = expectedReadOfNew(layout, input);
    const fn = LAYOUT_INFO[layout].writeFn;
    // Una sola forma por intento. Si la balanza contesta E5 (largo incorrecto) se frena: NO se prueba la otra.
    const variant = this.createChecksum === "con" ? "con control" : "SIN control (experimental, solo laboratorio)";
    const r = await this.call(`crear PLU ${input.number} (${variant})`, fn, data, { token: WRITE_TOKEN, checksum: this.createChecksum === "con" });
    return this.confirmWrite(layout, input.number, r, expected, null);
  }

  private async confirmWrite(layout: SystelLayout, number: number, reply: SystelReply | null, expected: Omit<SystelPlu, "managedBy" | "raw">, before: SystelPlu | null): Promise<WriteOutcome> {
    if (reply && reply.kind === "error") {
      return { ok: false, verdict: "rechazada", detail: `la balanza rechazó el PLU ${number} (${describeSystelError(reply.errorCode)})`, readBack: null, diff: [] };
    }
    // Se relee SIEMPRE antes de cualquier otra cosa (y antes de un eventual reintento, que nunca es automático).
    const back = await this.readPlu(layout, number);
    if (!reply || reply.kind !== "ack") {
      // Sin respuesta, respuesta ambigua o algo que no es ACK: la escritura queda INDETERMINADA aunque la
      // relectura coincida. Se informa lo que muestra la relectura y no se cuenta como confirmada.
      const shows = !back ? "no se pudo releer" : diffPlu(expected, back).length === 0 ? "la relectura muestra el valor nuevo" : before && diffPlu(expectedAfterPriceChange(before, before.prices[0]), back).length === 0 ? "la relectura muestra el valor anterior" : `la relectura muestra otra cosa (${diffPlu(expected, back).join(", ")})`;
      return { ok: false, verdict: "indeterminado", detail: `la balanza no confirmó la escritura del PLU ${number} (${reply ? `contestó "${reply.data}"` : "sin respuesta o respuesta ambigua"}); ${shows}`, readBack: back, diff: back ? diffPlu(expected, back) : [] };
    }
    if (!back) return { ok: false, verdict: "sin_relectura", detail: `no se pudo releer el PLU ${number} después de escribirlo`, readBack: null, diff: [] };
    const diff = diffPlu(expected, back);
    if (diff.length === 0) return { ok: true, verdict: "confirmado", detail: "", readBack: back, diff };
    if (before && diffPlu(expectedAfterPriceChange(before, before.prices[0]), back).length === 0) {
      return { ok: false, verdict: "sin_cambios", detail: `el PLU ${number} quedó como estaba (la balanza no aplicó el cambio)`, readBack: back, diff };
    }
    return { ok: false, verdict: "diferencia", detail: `el PLU ${number} volvió distinto en: ${diff.join(", ")}`, readBack: back, diff };
  }
}

export interface WriteOutcome {
  ok: boolean;
  verdict: "confirmado" | "indeterminado" | "rechazada" | "ocupado" | "sin_relectura" | "sin_cambios" | "diferencia" | "bloqueado";
  detail: string;
  readBack: SystelPlu | null;
  diff: PluField[];
}

const BLOCKED: WriteOutcome = { ok: false, verdict: "bloqueado", detail: "el envío a la balanza está bloqueado en Patagonia: por ahora solo se lee", readBack: null, diff: [] };
