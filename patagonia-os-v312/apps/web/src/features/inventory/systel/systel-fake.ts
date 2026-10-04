import type { SystelLink } from "./systel-client";
import { xorChecksum } from "./systel-frame";
import { LAYOUT_INFO, type SystelLayout } from "./systel-plu";

/**
 * Cuora simulada según los documentos oficiales de Systel (para las pruebas
 * automáticas). Responde las funciones 2, 23, 31, 39, 3/62, 33 y 4/61 y anota
 * todo lo que recibe. Cualquier otra función responde E4 (como una balanza que
 * no la conoce) y queda anotada, para que las pruebas comprueben que Patagonia
 * nunca la mandó.
 *
 * `writeChecksum`: si la escritura de un PLU (61/4) lleva verificación al final.
 * El documento no la muestra; la balanza real lo decide.
 */
export class FakeCuora implements SystelLink {
  /** Registros en formato de LECTURA (respuesta de 62/3), por número. */
  readonly plus = new Map<number, string>();
  readonly received: { fn: number; data: string }[] = [];
  silent = false;
  /** Rompe el registro del PLU indicado después de una escritura (para probar el freno). */
  corruptAfterWrite: number | null = null;
  /** No aplica los cambios de precio (contesta ACK igual). */
  ignorePriceChange = false;

  constructor(
    readonly layout: SystelLayout,
    readonly options: { address?: number; decimals?: number; capacity?: number; writeChecksum?: boolean } = {}
  ) {}

  get address(): number {
    return this.options.address ?? 1;
  }

  private reply(fn: number, data: string): Uint8Array {
    const body = [this.address, fn, ...Array.from(data, (c) => c.charCodeAt(0))];
    return Uint8Array.from([...body, xorChecksum(body)]);
  }

  async exchange(frame: Uint8Array): Promise<Uint8Array | null> {
    const addr = frame[0];
    const fn = frame[1];
    const info = LAYOUT_INFO[this.layout];
    const isPluWrite = fn === info.writeFn;
    const expectsCheck = isPluWrite ? this.options.writeChecksum ?? true : true;
    const payloadEnd = expectsCheck ? frame.length - 1 : frame.length;
    const data = String.fromCharCode(...frame.subarray(2, payloadEnd));
    this.received.push({ fn, data });
    if (this.silent) return null;
    if (addr !== this.address && addr !== 0) return null;
    if (expectsCheck && xorChecksum(frame.subarray(0, frame.length - 1)) !== frame[frame.length - 1]) {
      return isPluWrite ? this.reply(fn, "E5") : this.reply(fn, "E1");
    }
    const pd = info.pluDigits;
    switch (fn) {
      case 2: {
        const cap = String(this.options.capacity ?? (this.layout === "cuora2" ? 4000 : 8000)).padStart(5, "0");
        return this.reply(fn, `F0001C031000S0040P${cap}A060D${this.options.decimals ?? 0}`);
      }
      case 23:
        return this.reply(fn, "00T");
      case 39:
        return this.reply(fn, `Ton=2;Gris=0;Pap=0;Apa=1;Vel=5;Cpr=${this.options.decimals ?? 0};Sinc=0;E_P=20PPPPIIIIII;E_U=21PPPPIIIIII;Cim=1`);
      case 31: {
        const nums = [...this.plus.keys()].sort((a, b) => a - b);
        return this.reply(fn, nums.map((n) => `N${String(n).padStart(pd, "0")}V${this.plus.get(n)![pd]}`).join("") + "F");
      }
      case 3:
      case 62: {
        if (fn !== info.readFn) return this.reply(fn, "E4");
        if (data.length !== pd || !/^\d+$/.test(data)) return this.reply(fn, "E5");
        const rec = this.plus.get(Number(data));
        return rec ? this.reply(fn, rec) : this.reply(fn, "E7");
      }
      case 33: {
        if (data.length !== pd + 1 + 12) return this.reply(fn, "E5");
        const n = Number(data.slice(0, pd));
        const rec = this.plus.get(n);
        if (!rec) return this.reply(fn, "E7");
        if (!this.ignorePriceChange) {
          const p1 = data.slice(pd + 1, pd + 7);
          const p2 = data.slice(pd + 7, pd + 13);
          const afterName = pd + 1 + 18;
          const updated =
            this.layout === "max7"
              ? rec.slice(0, afterName) + p1 + rec.slice(afterName + 6, afterName + 12) + p2 + rec.slice(afterName + 18)
              : rec.slice(0, afterName) + p1 + p2 + rec.slice(afterName + 12);
          this.plus.set(n, updated);
        }
        return this.reply(fn, "ACK");
      }
      case 4:
      case 61: {
        if (fn !== info.writeFn) return this.reply(fn, "E4");
        const n = Number(data.slice(0, pd));
        let rec: string;
        if (this.layout === "cuora2") {
          // Escritura: …tara(6) + N/M + ingredientes. Lectura: lo mismo sin la letra N/M.
          const tareEnd = 4 + 1 + 18 + 12 + 5 + 2 + 4 + 1 + 6;
          rec = data.slice(0, tareEnd) + data.slice(tareEnd + 1);
        } else {
          rec = data.slice(0, pd) + "1" + data.slice(pd);
        }
        const fixed = info.pluDigits + 1 + 18 + info.priceLists * (this.layout === "max7" ? 12 : 6) + info.codeDigits + 2 + 4 + 1 + info.tareDigits;
        const tail = rec.slice(fixed);
        const flag = tail[info.tailFixed - 1];
        if (tail.length !== info.tailFixed + (flag === "S" ? 100 : 0)) return this.reply(fn, "E5");
        this.plus.set(n, rec);
        if (this.corruptAfterWrite === n) this.plus.set(n, rec.slice(0, pd + 1) + "X" + rec.slice(pd + 2));
        return this.reply(fn, "ACK");
      }
      default:
        return this.reply(fn, "E4");
    }
  }
}

/** Arma un registro de LECTURA para cargar la balanza simulada con productos "del cliente". */
export function fakeReadRecord(layout: SystelLayout, p: { number: number; name: string; price: number; code: number; type: "P" | "U"; tare?: number; managedBy?: string }): string {
  const info = LAYOUT_INFO[layout];
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const prices = layout === "max7" ? pad(p.price, 6) + "000000" + "000000000000".repeat(4) : pad(p.price, 6) + "000000";
  const nutrition = layout === "max7" ? "N" + " ".repeat(30) + "0000".repeat(12) : "N" + " ".repeat(30) + "0000".repeat(8);
  const tail = layout === "cuora2" ? "N" : "0000" + nutrition + "0001" + "0000" + "0000" + "000000000123" + "1" + "20PPPPIIIIII" + "N";
  return `${pad(p.number, info.pluDigits)}${p.managedBy ?? "0"}${p.name.padEnd(18).slice(0, 18)}${prices}${pad(p.code, info.codeDigits)}01${pad(5, 4)}${p.type}${pad(p.tare ?? 0, info.tareDigits)}${tail}`;
}
