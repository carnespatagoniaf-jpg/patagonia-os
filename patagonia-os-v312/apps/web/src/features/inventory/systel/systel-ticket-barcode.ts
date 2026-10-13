import type { SystelClient } from "./systel-client";
import { parseConfig } from "./systel-plu";

/**
 * Activar "imprimir el código de barras de cada producto en el ticket" en una balanza Systel
 * (cualquier Cuora con el protocolo V4.0, V6.0, V6.2 o V7: la función 7 es igual en los cuatro).
 *
 * Por qué: con esa opción apagada (real, Los gringos 2026-10-13: "ETi=N") el ticket trae debajo de
 * cada producto un código en blanco ("0 000000 000000") y Mostrador no puede saber qué se vendió ni
 * descontar stock. Encendida, cada producto sale con 20 + N.º de producto + cantidad.
 *
 * Pasos (nada se da por hecho sin releer):
 * 1. Lee la configuración (39). Si no la lee, o no informa ese parámetro, NO manda nada.
 * 2. Si ya está en S, no manda nada.
 * 3. Manda UNA orden: función 7 "XS" (X = "el parámetro permanece sin cambio" en el otro dato).
 * 4. Relee la configuración: tiene que haber cambiado SOLO ese parámetro, de N a S.
 * Sin ACK, el resultado es "indeterminado" aunque la relectura muestre el cambio.
 */

export type TicketBarcodeOutcome =
  | "ya_activado"
  | "activado"
  | "indeterminado"
  | "sin_cambios"
  | "diferencia"
  | "rechazado"
  | "sin_lectura"
  | "no_soportado"
  | "bloqueado";

export interface TicketBarcodeResult {
  outcome: TicketBarcodeOutcome;
  ok: boolean;
  detail: string;
  /** Nombre del parámetro tal como lo informa la balanza (real: "ETi"). */
  key: string | null;
  before: string | null;
  after: string | null;
  changed: string[];
}

function findKey(values: Record<string, string>): string | null {
  return Object.keys(values).find((k) => k.toLowerCase() === "eti") ?? null;
}

export async function enableTicketBarcodes(client: SystelClient): Promise<TicketBarcodeResult> {
  const base = { key: null as string | null, before: null as string | null, after: null as string | null, changed: [] as string[] };
  const first = await client.config();
  if (!first) return { ...base, outcome: "sin_lectura", ok: false, detail: "no se pudo leer la configuración de la balanza; no se mandó nada" };
  const before = parseConfig(first.raw);
  const key = findKey(before);
  if (!key) {
    return { ...base, before: first.raw, outcome: "no_soportado", ok: false, detail: "la balanza no informa la opción \"imprimir código en tickets\": no se puede comprobar el cambio, así que no se mandó nada" };
  }
  if (before[key].toUpperCase() === "S") {
    return { ...base, key, before: first.raw, after: first.raw, outcome: "ya_activado", ok: true, detail: "la opción \"imprimir código en tickets\" ya estaba activada en la balanza; no se mandó nada. Si igual sale en blanco (0 000000 000000), el código lo define cada producto de la balanza: en el Mostrador escaneá el código del TOTAL y elegí el producto" };
  }

  const reply = await client.setTicketBarcodes(true);
  if (reply === "bloqueado") return { ...base, key, before: first.raw, outcome: "bloqueado", ok: false, detail: "la orden está bloqueada en Patagonia" };

  const second = await client.config();
  if (!second) {
    return { ...base, key, before: first.raw, outcome: "indeterminado", ok: false, detail: `se mandó la orden (${reply ? `respuesta "${reply.data}"` : "sin respuesta"}) pero no se pudo releer la configuración para comprobarla` };
  }
  const after = parseConfig(second.raw);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changed = keys.filter((k) => before[k] !== after[k]);
  const res = { key, before: first.raw, after: second.raw, changed };

  if (reply && reply.kind === "error") {
    return changed.length === 0
      ? { ...res, outcome: "rechazado", ok: false, detail: `la balanza rechazó la orden (${reply.data}) y no cambió nada` }
      : { ...res, outcome: "diferencia", ok: false, detail: `la balanza rechazó la orden (${reply.data}) pero cambió: ${changed.join(", ")}` };
  }
  if (changed.length === 0) return { ...res, outcome: "sin_cambios", ok: false, detail: "la balanza contestó pero no cambió la opción (sigue sin imprimir el código por producto)" };
  if (changed.length !== 1 || changed[0] !== key || (after[key] ?? "").toUpperCase() !== "S") {
    return { ...res, outcome: "diferencia", ok: false, detail: `cambió algo distinto de lo pedido: ${changed.map((k) => `${k} ${before[k] ?? "-"}→${after[k] ?? "-"}`).join(", ")}` };
  }
  if (!reply || reply.kind !== "ack") {
    return { ...res, outcome: "indeterminado", ok: false, detail: `la relectura muestra el cambio, pero la balanza no confirmó la orden (${reply ? `contestó "${reply.data}"` : "sin respuesta"})` };
  }
  return { ...res, outcome: "activado", ok: true, detail: "listo: desde ahora la balanza imprime el código de cada producto en el ticket (solo cambió esa opción)" };
}
