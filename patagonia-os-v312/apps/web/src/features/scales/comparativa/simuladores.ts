import { kretzChecksum } from "../../inventory/kretz/kretz-frame";

/**
 * Simuladores de la prueba comparativa (escenarios.ts). Son los MISMOS para el sistema viejo y el nuevo: hablan con el
 * código de producción por las mismas interfaces que una balanza de verdad (Web Serial). Copiados de las pruebas de la
 * rama nueva (kretz-safety.test.ts y scale-weight-ports.test.ts), que no se pueden importar sin correr sus pruebas.
 * Solo pruebas: no los usa ninguna pantalla.
 */

const WIDTHS_PAD = (v: number, w: number) => String(v).padStart(w, "0");
const TXT = (s: string, w: number) => s.padEnd(w, " ").slice(0, w);

/** Un producto de la Report tal como lo guarda (135 caracteres). */
export function reportRecord(plu: number, name: string, price: number, opts: { label?: string; unit?: "P" | "U" } = {}): string {
  const d = WIDTHS_PAD;
  return [d(plu, 6), d(1, 3), d(1, 3), TXT(name, 26), TXT("", 26), d(plu, 5), opts.unit ?? "P", d(0, 7), d(price, 6), d(0, 6), d(2, 6), d(0, 6), d(0, 6), d(0, 5), d(0, 5), opts.label ?? "01", d(0, 4), d(0, 4), d(1000, 4), d(0, 4)].join("");
}

/** Kretz Report por cable (tramas reales: 2005 alta, 5005 leer el siguiente, 1070 código de barras). */
export class FakeReport {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  records = new Map<number, string>();
  writes: number[] = [];
  commands: string[] = [];
  opens = 0;
  closes = 0;
  /** Contesta "01" a la escritura de estos PLU sin grabar nada (lo que hace la real con algunos PLU de iTegra). */
  ignore = new Set<number>();
  /** Al leer el PLU siguiente a este número contesta `badCode` (error a mitad de la lectura). */
  badAfter: number | null = null;
  badCode = "60";
  getInfo() {
    return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
  }
  async open() {
    this.opens++;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const reply = (code: string, data = "") => {
      const body = [0x07, ...Array.from(`C0100${code}${data}`, (c) => c.charCodeAt(0))];
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
        if (chunk[0] !== 0x02) return;
        const text = String.fromCharCode(...chunk.slice(1, chunk.length - 3));
        const command = text.slice(3, 7);
        const data = text.slice(7);
        this.commands.push(command);
        if (command === "2005") {
          const plu = Number(data.slice(0, 6));
          this.writes.push(plu);
          if (!this.ignore.has(plu)) this.records.set(plu, data);
          reply("01");
        } else if (command === "5005") {
          const after = Number(data);
          if (this.badAfter !== null && after === this.badAfter) {
            reply(this.badCode);
            return;
          }
          const next = [...this.records.keys()].filter((k) => k > after).sort((a, b) => a - b)[0];
          if (next === undefined) reply("20");
          else reply("01", this.records.get(next)!);
        } else if (command === "1070") {
          reply("01");
        } else reply("02");
      }
    });
  }
  async close() {
    this.closes++;
    this.readable = null;
    this.writable = null;
  }
  /** Nombre grabado hoy en ese PLU (o null). */
  nameAt(plu: number): string | null {
    const r = this.records.get(plu);
    return r ? r.slice(12, 38).trim() : null;
  }
}

/** Un puerto serie cualquiera (balanza de peso u otra), que cuenta cuántas veces lo abrieron y cerraron. */
export class FakeSerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  opens = 0;
  closes = 0;
  constructor(
    private reply: string | null,
    private info: { usbVendorId?: number; usbProductId?: number } = {}
  ) {}
  getInfo() {
    return this.info;
  }
  async open() {
    this.opens++;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const reply = this.reply;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (reply && chunk[0] === 0x57) controller.enqueue(new TextEncoder().encode(reply));
      }
    });
  }
  async close() {
    this.closes++;
    this.readable = null;
    this.writable = null;
  }
}
