import { collect } from "./discovery";
import { claimPort, closeQuietly, errorClassification, freshPortFor, newSession, openForSession, releasePort } from "./port-session";

/**
 * "Escuchar la balanza" (prueba 1 del ticket acumulado, SOLO LECTURA: no manda ni un byte).
 *
 * La Aura puede imprimir en una impresora externa ESC/POS ("TM-T58", manual Aura Eco §7.1.8). Si el impresor de la
 * balanza se pone en TM-T58 y el cable va a la PC, el ticket completo (cada producto con kilos, precio e importe,
 * total, N.º de ticket) tendría que llegar por ese cable. Esto escucha durante un rato y muestra lo que llegó:
 * si es texto legible, Patagonia puede guardar el detalle de cada ticket e imprimirlo con un código por producto.
 */

export interface ListenResult {
  ok: boolean;
  detail: string;
  bytes: number;
  /** Lo que llegó como texto (los saltos de línea se respetan; lo no imprimible va como "·"). */
  text: string;
  hex: string;
  /** Llegó una imagen (GS v 0 / ESC *): el ticket vendría dibujado, no como texto. */
  raster: boolean;
}

/** Bytes de ESC/POS → texto legible. Pura (probada). */
export function escposToText(bytes: number[]): { text: string; raster: boolean } {
  let text = "";
  let raster = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) raster = true; // GS v 0: imagen
    if (b === 0x1b && bytes[i + 1] === 0x2a) raster = true; // ESC *: imagen por columnas
    if (b === 0x0a) text += "\n";
    else if (b === 0x0d) continue;
    else if (b >= 0x20 && b <= 0x7e) text += String.fromCharCode(b);
    else if (b >= 0xa0) text += String.fromCharCode(b); // acentos en códigos de página latinos
    else text += "·";
  }
  return { text, raster };
}

export async function listenScale(port: SerialPort, options: { baudRate: number; stopBits?: 1 | 2; seconds?: number }): Promise<ListenResult> {
  const empty = { bytes: 0, text: "", hex: "", raster: false };
  if (!claimPort(port)) return { ok: false, detail: "ya hay otra operación con esta balanza en esta pestaña", ...empty };
  const claimed = port;
  try {
    port = await freshPortFor(port);
    try {
      await openForSession(port, { baudRate: options.baudRate, dataBits: 8, stopBits: options.stopBits ?? 1, parity: "none" }, newSession(4, []));
    } catch (err) {
      const c = errorClassification(err);
      return { ok: false, detail: `no se pudo abrir el puerto: ${c ? c.explanation : err instanceof Error ? err.message : String(err)}`, ...empty };
    }
    const got = await collect(port, (options.seconds ?? 60) * 1000, false);
    const { text, raster } = escposToText(got);
    const hex = got.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    return {
      ok: got.length > 0,
      detail: got.length === 0 ? "no llegó nada por el cable" : raster ? `llegaron ${got.length} bytes, con una IMAGEN (el ticket vendría dibujado)` : `llegaron ${got.length} bytes`,
      bytes: got.length,
      text,
      hex,
      raster
    };
  } finally {
    await closeQuietly(port);
    releasePort(claimed);
  }
}
