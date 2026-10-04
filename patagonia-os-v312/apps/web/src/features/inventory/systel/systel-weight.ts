import { xorChecksum } from "./systel-frame";

/**
 * Lectura de peso de las balanzas Systel sin memoria de productos para PC
 * (Croma, Clipse, Bumer, Maya…). Fuente: "Protocolo de comunicación RS232 Systel" Rev 10.
 * El documento dice que hay 4 protocolos y que "debe hacer la prueba con los 4
 * protocolos disponibles y verificar a cual responde". Los parámetros del puerto
 * y algunos ejemplos están en imágenes del PDF: por eso esto es tolerante y la
 * activación necesita que el cajero confirme que el peso coincide con el visor.
 *
 * A: PC manda 05. Estable: 02 + peso (6, o "-" + 6) + 03 + XOR. Inestable: 11.
 * B: PC manda 07 07 (opción 1) o 07 (opción 2). Peso (5/6, o con "-") + "e"/"i" + XOR.
 * C (Torrey): PC manda "P". CR + peso ("-###.###").
 * D (CAS): PC manda "W". 02 + peso + CR.
 * Cuora (función 1 del protocolo de la Cuora): peso neto en gramos (6) + e/i + tara (6).
 */

export type SystelWeightProtocol = "A" | "B1" | "B2" | "C" | "D";

export const WEIGHT_REQUEST: Record<SystelWeightProtocol, number[]> = {
  A: [0x05],
  B1: [0x07, 0x07],
  B2: [0x07],
  C: [0x50],
  D: [0x57]
};

export interface SystelWeightReading {
  /** El peso tal como vino (como el visor de la balanza). */
  display: string;
  /** Kilos, si se pudo interpretar (con punto decimal = kg; sin punto = HIPÓTESIS, se pide confirmar). */
  kg: number | null;
  stable: boolean | null;
  /** true si el número traía punto decimal (lectura segura). */
  hasDecimalPoint: boolean;
}

function toKg(display: string): { kg: number | null; hasDecimalPoint: boolean } {
  const s = display.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { kg: null, hasDecimalPoint: false };
  return { kg: Number(s), hasDecimalPoint: s.includes(".") };
}

export function parseWeightReply(protocol: SystelWeightProtocol, bytes: Uint8Array): SystelWeightReading | "inestable" | null {
  const text = String.fromCharCode(...bytes);
  if (protocol === "A") {
    if (bytes.length === 1 && bytes[0] === 0x11) return "inestable";
    const stx = bytes.indexOf(0x02);
    const etx = bytes.indexOf(0x03, stx + 1);
    if (stx < 0 || etx < 0) return null;
    const display = String.fromCharCode(...bytes.subarray(stx + 1, etx));
    // La verificación se calcula sobre la cadena; según el ejemplo (imagen) puede incluir o no 02/03: se aceptan las dos.
    const check = bytes[etx + 1];
    if (check !== undefined) {
      const okWith = xorChecksum(bytes.subarray(stx, etx + 1)) === check;
      const okWithout = xorChecksum(bytes.subarray(stx + 1, etx)) === check;
      if (!okWith && !okWithout) return null;
    }
    return { display, ...toKg(display), stable: true };
  }
  if (protocol === "B1" || protocol === "B2") {
    const m = /(-?[\d.]{5,7})([ei])/.exec(text);
    if (!m) return null;
    return { display: m[1], ...toKg(m[1]), stable: m[2] === "e" };
  }
  if (protocol === "C") {
    const m = /\r\s*(-?\d+(?:\.\d+)?)/.exec(text);
    return m ? { display: m[1], ...toKg(m[1]), stable: null } : null;
  }
  const m = /\x02\s*(-?\d+(?:\.\d+)?)\s*\r/.exec(text);
  return m ? { display: m[1], ...toKg(m[1]), stable: null } : null;
}

/** Función 1 de la Cuora: "000250e000000" = 250 g estable, tara 0. "-00250i…" = negativo inestable. */
export function parseCuoraWeight(data: string): { grams: number; stable: boolean; tareGrams: number } | null {
  const m = /^(-\d{5}|\d{6})([ei])(\d{6})$/.exec(data);
  if (!m) return null;
  return { grams: Number(m[1]), stable: m[2] === "e", tareGrams: Number(m[3]) };
}
