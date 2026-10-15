import { sendRead, type DiagnosticExchange } from "./discovery";
import type { KretzResponder } from "./discovery";
import { claimPort, closeQuietly, errorClassification, freshPortFor, newSession, openForSession, releasePort } from "./port-session";

/**
 * Prueba SOLO DE LECTURA: ¿la Aura entrega lo vendido de cada producto ("Total por PLU", manual §12.7.7)?
 *
 * "Multiprotocolo Report Nx" R30: 5008 = "Lectura de totales por PLU" (PLU 6 + fecha 6 + horario 2 + ventas 8 +
 * importe 9 + peso/unidades 9 + importe preempaque 9 + peso/unidades preempaque 9). En la Report devuelve solo el
 * PRIMER registro y para avanzar hay que BORRARLO (3008): eso NO se hace acá. Se prueba si la Aura acepta un número
 * de PLU (como 5005, "el siguiente mayor") para recorrer los totales SIN borrar nada. iTegra Mobile lee los totales
 * de la Aura por Bluetooth (Guía Bluetooth, Kretz), así que algún camino de lectura existe.
 *
 * Solo manda 5001, 5008 y 5009 (todas de lectura: assertReadOnly lo garantiza). Nunca 3008/4008.
 */

export interface TotalsRecord {
  plu: number;
  date: string;
  range: string;
  sales: number;
  amount: number;
  quantity: number;
}

export interface TotalsProbeResult {
  verdict: "recorre_sin_borrar" | "solo_el_primero" | "sin_totales" | "no_existe" | "sin_respuesta" | "puerto";
  detail: string;
  records: TotalsRecord[];
  exchanges: DiagnosticExchange[];
}

/** Datos de una respuesta 5008 (58 caracteres). null si no tiene esa forma. */
export function parseTotalsRecord(data: string): TotalsRecord | null {
  const d = data.trim();
  if (!/^\d{58}/.test(d)) return null;
  return {
    plu: Number(d.slice(0, 6)),
    date: d.slice(6, 12),
    range: d.slice(12, 14),
    sales: Number(d.slice(14, 22)),
    amount: Number(d.slice(22, 31)),
    quantity: Number(d.slice(31, 40))
  };
}

export async function probeAuraTotals(port: SerialPort, responder: KretzResponder, options: { timeoutMs?: number; onProgress?: (t: string) => void } = {}): Promise<TotalsProbeResult> {
  const exchanges: DiagnosticExchange[] = [];
  const timeout = options.timeoutMs ?? 1500;
  const progress = options.onProgress ?? (() => {});
  if (!claimPort(port)) return { verdict: "puerto", detail: "ya hay otra operación con esta balanza en esta pestaña", records: [], exchanges };
  const claimed = port;
  try {
    port = await freshPortFor(port);
    try {
      await openForSession(port, { baudRate: responder.link.baudRate, dataBits: 8, stopBits: responder.link.stopBits, parity: "none" }, newSession(4, []));
    } catch (err) {
      const c = errorClassification(err);
      return { verdict: "puerto", detail: `no se pudo abrir el puerto: ${c ? c.explanation : err instanceof Error ? err.message : String(err)}`, records: [], exchanges };
    }
    const read = (step: string, command: string, data: string) =>
      sendRead(port, exchanges, step, responder.link, responder.deviceType, responder.equipmentId, command, data, timeout);

    progress("Probando la conexión…");
    const ping = await read("test de conexión", "0001", "");
    if (!ping.kretz) return { verdict: "sin_respuesta", detail: "la balanza no contestó el test de conexión", records: [], exchanges };

    progress("Leyendo el primer total por producto (solo lectura)…");
    const first = await read("totales por PLU (primero)", "5008", "");
    const code = first.kretz?.code ?? null;
    if (code === "02") {
      await read("totales por vendedor", "5009", "");
      return { verdict: "no_existe", detail: "la balanza no tiene la lectura de totales por producto (respuesta 02)", records: [], exchanges };
    }
    if (code === "40") return { verdict: "sin_totales", detail: "la balanza contestó que no tiene totales por producto guardados (respuesta 40)", records: [], exchanges };
    const r1 = first.kretz?.data ? parseTotalsRecord(first.kretz.data) : null;
    if (!r1) return { verdict: "sin_respuesta", detail: `respuesta ${code ?? "sin código"} con un formato que no se reconoce: ${first.rxText}`, records: [], exchanges };

    // ¿Acepta un número de PLU para seguir (como 5005)? Se pide el siguiente al primero, sin borrar nada.
    progress("Probando si se pueden recorrer sin borrar (solo lectura)…");
    const records = [r1];
    let after = r1.plu;
    for (let i = 0; i < 5; i++) {
      const next = await read(`totales por PLU después del ${after}`, "5008", String(after).padStart(6, "0"));
      const r = next.kretz?.data ? parseTotalsRecord(next.kretz.data) : null;
      if (!r || r.plu <= after) break;
      records.push(r);
      after = r.plu;
    }
    await read("cantidad de registros de totales por PLU", "5001", "08");
    return records.length > 1
      ? { verdict: "recorre_sin_borrar", detail: `la balanza entrega los totales producto por producto sin borrar nada (${records.length} leídos)`, records, exchanges }
      : { verdict: "solo_el_primero", detail: "la balanza entrega el primer total, pero no acepta pedir el siguiente sin borrarlo", records, exchanges };
  } finally {
    await closeQuietly(port);
    releasePort(claimed);
  }
}
