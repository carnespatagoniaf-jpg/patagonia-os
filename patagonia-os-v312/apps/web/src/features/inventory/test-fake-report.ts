import { kretzChecksum } from "./kretz/kretz-frame";

/**
 * Kretz Report simulada para las pruebas (antes adentro de report-sync-e2e.test.ts; ahora la usa también
 * scales/sale/three-scales-e2e.test.ts). Guarda los registros de 135 caracteres tal cual llegan (2005), los devuelve con
 * 5005 ("el próximo PLU mayor al argumento", como la real) y anota el 1070. Solo pruebas.
 */
export class FakeReportScale {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  records = new Map<number, string>();
  writes: number[] = [];
  /** PLUs en los que la balanza contesta "01" pero no graba nada (lo que hace la real con algunos PLUs de iTegra). */
  ignore = new Set<number>();
  /** Departamentos que existen en la balanza (null = cualquiera). Un alta con otro contesta "21", como la de El Abastero. */
  departments: Set<string> | null = null;
  /** Lo que recibió con el comando 1070 (formato del código de barras de las etiquetas), en orden. */
  barcodeConfigs: string[] = [];
  getInfo() {
    return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
  }
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const reply = (code: string, data = "") => {
      const body = [0x07, ..."C01".split("").map((c) => c.charCodeAt(0)), 0x30, 0x30, ...code.split("").map((c) => c.charCodeAt(0)), ...Array.from(data, (c) => c.charCodeAt(0))];
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
        if (command === "2005") {
          if (data.length !== 135) throw new Error("el registro 2005 tiene que tener 135 caracteres");
          const plu = Number(data.slice(0, 6));
          this.writes.push(plu);
          if (this.departments && !this.records.has(plu) && !this.departments.has(data.slice(6, 9))) {
            reply("21");
            return;
          }
          if (!this.ignore.has(plu)) this.records.set(plu, data);
          reply("01");
        } else if (command === "5005") {
          const after = Number(data);
          const next = [...this.records.keys()].filter((k) => k > after).sort((a, b) => a - b)[0];
          if (next === undefined) reply("02");
          else reply("01", this.records.get(next)!);
        } else if (command === "1070") {
          this.barcodeConfigs.push(data);
          reply("01");
        } else {
          reply("02");
        }
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}
