import { kretzChecksum } from "../../inventory/kretz/kretz-frame";
import { auraWriteToReadOrder } from "../../inventory/kretz/aura-plu";
import type { FakeCuora } from "../../inventory/systel/systel-fake";
import type { SystelExchangeOptions, SystelLink } from "../../inventory/systel/systel-client";
import { xorChecksum } from "../../inventory/systel/systel-frame";
import { LAYOUT_INFO } from "../../inventory/systel/systel-plu";

/**
 * Balanzas simuladas CON INYECCIÓN DE FALLAS, para la matriz de envíos y las pruebas "un envío incompleto nunca es OK"
 * (scales/engine/envios-*.test.ts). Solo pruebas: no se usa en la app.
 *
 * Cada orden que recibe la balanza es una "operación" numerada desde 0. Una falla se aplica en la operación `at`:
 * - sin_respuesta: la orden no llega (no se hace nada, no se contesta);
 * - respuesta_perdida: la balanza la hace pero la respuesta se pierde en el cable;
 * - error: contesta un código de error sin hacer nada;
 * - ack_sin_grabar: contesta "hecho" a una escritura o configuración pero no guarda nada (en una lectura: normal);
 * - relectura_distinta: una lectura de producto devuelve el registro con el precio cambiado (en otra orden: normal);
 * - corte: se corta la conexión desde esa operación (Kretz: el puerto tira error y no se puede reabrir; Systel: silencio,
 *   como el enlace serie real, que nunca tira error y devuelve null).
 */

export type FaultKind = "sin_respuesta" | "respuesta_perdida" | "error" | "ack_sin_grabar" | "relectura_distinta" | "corte";
export const FAULT_KINDS: FaultKind[] = ["sin_respuesta", "respuesta_perdida", "error", "ack_sin_grabar", "relectura_distinta", "corte"];

export interface Fault {
  at: number;
  kind: FaultKind;
}

export type OpClass = "lectura" | "relectura" | "escritura" | "configuracion";

export interface OpRecord {
  index: number;
  command: string;
  cls: OpClass;
  /** Número de producto que toca la orden (si toca uno). */
  plu: number | null;
}

const hit = (f: Fault | null, index: number) => !!f && (f.kind === "corte" ? index >= f.at : index === f.at);

/** Cambia el último dígito del precio en `at..at+6` (relectura distinta). */
function corruptDigit(s: string, at: number): string {
  const i = at + 5;
  const d = Number(s[i]);
  if (!Number.isInteger(d)) return s;
  return s.slice(0, i) + String((d + 1) % 10) + s.slice(i + 1);
}

// ── Kretz (Report y Aura): tramas reales STX…EOT por un puerto Web Serial simulado ─────────────────────────────────

/**
 * Report: guarda el registro 2005 de 135 caracteres tal cual; 5005 devuelve el siguiente mayor ("02" al final), como
 * test-fake-report.ts. Aura: guarda el 2005 de 42 caracteres en orden de LECTURA (auraWriteToReadOrder, comprobado en la
 * Aura real) y al final de la lista contesta "40".
 */
export class SimKretzScale {
  readonly records = new Map<number, string>();
  readonly barcodeConfigs: string[] = [];
  readonly ops: OpRecord[] = [];
  fault: Fault | null = null;
  errorCode = "10";
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  connected = true;
  private cut = false;
  private written = new Set<number>();

  constructor(readonly mode: "report" | "aura") {}

  getInfo(): SerialPortInfo {
    return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
  }

  async open(_options?: SerialOptions): Promise<void> {
    if (this.cut) throw Object.assign(new Error("The device has been lost."), { name: "NetworkError" });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    const reply = (letter: string, code: string, data = "") => {
      const body = [0x07, ...Array.from(`${letter}0100${code}${data}`, (c) => c.charCodeAt(0))];
      setTimeout(() => {
        try {
          controller.enqueue(new Uint8Array([...body, ...kretzChecksum(body), 0x04]));
        } catch {
          // cerrado
        }
      }, 0);
    };
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.cut) throw Object.assign(new Error("The device has been lost."), { name: "NetworkError" });
        if (chunk[0] !== 0x02) return;
        const text = String.fromCharCode(...chunk.slice(1, chunk.length - 3));
        const letter = text[0];
        const command = text.slice(3, 7);
        const data = text.slice(7);
        const index = this.ops.length;
        const plu = command === "2005" ? Number(data.slice(0, 6)) : command === "5005" ? Number(data) + 1 : null;
        const cls: OpClass = command === "2005" ? "escritura" : command === "1070" ? "configuracion" : command === "5005" && plu !== null && this.written.has(plu) ? "relectura" : "lectura";
        this.ops.push({ index, command, cls, plu });
        const f = hit(this.fault, index) ? this.fault! : null;
        if (f?.kind === "corte") {
          this.cut = true;
          throw Object.assign(new Error("The device has been lost."), { name: "NetworkError" });
        }
        if (f?.kind === "sin_respuesta") return;
        if (f?.kind === "error") return reply(letter, this.errorCode);
        const isWrite = command === "2005" || command === "1070";
        const r = f?.kind === "ack_sin_grabar" && isWrite ? { code: "01", data: "" } : this.handle(command, data);
        if (f?.kind === "respuesta_perdida") return;
        if (f?.kind === "relectura_distinta" && command === "5005" && r.code === "01" && r.data) {
          r.data = corruptDigit(r.data, this.mode === "report" ? 77 : 29);
        }
        reply(letter, r.code, r.data);
      }
    });
  }

  async close(): Promise<void> {
    this.readable = null;
    this.writable = null;
  }

  private handle(command: string, data: string): { code: string; data: string } {
    if (command === "0001") return { code: "01", data: "" };
    if (command === "2005") {
      const plu = Number(data.slice(0, 6));
      if (this.mode === "report") {
        if (data.length !== 135) return { code: "10", data: "" };
        this.records.set(plu, data);
      } else {
        if (data.length !== 42) return { code: "10", data: "" };
        this.records.set(plu, auraWriteToReadOrder(data));
      }
      this.written.add(plu);
      return { code: "01", data: "" };
    }
    if (command === "5005") {
      const after = Number(data);
      const next = [...this.records.keys()].filter((k) => k > after).sort((a, b) => a - b)[0];
      if (next === undefined) return { code: this.mode === "report" ? "02" : "40", data: "" };
      return { code: "01", data: this.records.get(next)! };
    }
    if (command === "1070") {
      this.barcodeConfigs.push(data);
      return { code: "01", data: "" };
    }
    return { code: "02", data: "" };
  }

  /** Copia de lo guardado (para comparar antes/después). */
  snapshot(): Map<number, string> {
    return new Map(this.records);
  }
}

// ── Systel: el enlace de la Cuora (SystelLink) con fallas delante de FakeCuora ─────────────────────────────────────

const SYSTEL_WRITES = new Set([4, 7, 10, 25, 33, 35, 61]);
const SYSTEL_PLU_READS = new Set([3, 62]);

export class FaultySystelLink implements SystelLink {
  readonly ops: OpRecord[] = [];
  fault: Fault | null = null;
  errorCode = "E5";
  private cut = false;
  private written = new Set<number>();

  constructor(readonly cuora: FakeCuora) {}

  private reply(address: number, fn: number, data: string): Uint8Array {
    const body = [address, fn, ...Array.from(data, (c) => c.charCodeAt(0))];
    return Uint8Array.from([...body, xorChecksum(body)]);
  }

  async exchange(frame: Uint8Array, _options?: SystelExchangeOptions): Promise<Uint8Array | null> {
    const index = this.ops.length;
    const fn = frame[1];
    const pd = LAYOUT_INFO[this.cuora.layout].pluDigits;
    const payload = String.fromCharCode(...frame.subarray(2, Math.min(frame.length, 2 + pd)));
    const plu = SYSTEL_PLU_READS.has(fn) || fn === 61 || fn === 4 ? Number(payload) : null;
    const cls: OpClass = SYSTEL_WRITES.has(fn) ? (fn === 61 || fn === 4 || fn === 33 ? "escritura" : "configuracion") : plu !== null && this.written.has(plu) ? "relectura" : "lectura";
    this.ops.push({ index, command: String(fn), cls, plu });
    if (cls === "escritura" && plu !== null) this.written.add(plu);
    const f = hit(this.fault, index) ? this.fault! : null;
    if (this.cut || f?.kind === "corte") {
      this.cut = true;
      return null;
    }
    const address = frame[0] === 0 ? this.cuora.address : frame[0];
    if (f?.kind === "sin_respuesta") return null;
    if (f?.kind === "error") return this.reply(address, fn, this.errorCode);
    if (f?.kind === "ack_sin_grabar" && SYSTEL_WRITES.has(fn)) return this.reply(address, fn, "ACK");
    const r = await this.cuora.exchange(frame);
    if (f?.kind === "respuesta_perdida") return null;
    if (f?.kind === "relectura_distinta" && r && SYSTEL_PLU_READS.has(fn)) {
      const data = String.fromCharCode(...r.subarray(2, r.length - 1));
      if (!/^E\d$/.test(data) && data.length > pd + 25) return this.reply(r[0], r[1], corruptDigit(data, pd + 1 + 18));
    }
    return r;
  }
}

/** Cuántas operaciones de cada clase hubo (para el informe de cobertura). */
export function opClasses(ops: OpRecord[]): Record<OpClass, number> {
  const out: Record<OpClass, number> = { lectura: 0, relectura: 0, escritura: 0, configuracion: 0 };
  for (const o of ops) out[o.cls]++;
  return out;
}
