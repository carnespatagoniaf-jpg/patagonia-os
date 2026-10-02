import { auraWriteToReadOrder, buildAuraWriteRecord, parseAuraPlu, rewriteWithNewPrice } from "./aura-plu";

/**
 * Plan de envío de PRECIOS y PRODUCTOS a la Kretz Aura (no envía nada: arma qué mandar).
 *
 * Formato de escritura capturado del programa oficial iTegra (aura-plu.ts,
 * buildAuraWriteRecord): código (6) antes del tipo P/N. Cambio de precio = reenviar
 * el registro completo con el mismo código y tipo (como iTegra), sin borrar nada.
 *
 * - Producto que ya está en la balanza con tipo P o N → "actualizar": cambia SOLO
 *   el precio; nombre, código, tipo, tara y validez quedan como estaban.
 * - Tipo D o C (existen en la balanza de la clienta; iTegra no los usa) → "revisar":
 *   no se sabe todavía cómo se escriben, no se tocan.
 * - PLU que no está en la balanza → "crear" con tipo P (por kilo) o N (por unidad)
 *   y el código que se indique (por defecto, el número de PLU).
 * Pendiente de confirmar en la balanza real (una sola prueba): que releer después de
 * escribir devuelva el mismo tipo y código (aura-write-test.ts).
 */

export type AuraPlanAction = "actualizar" | "crear" | "revisar" | "omitir" | "sin_cambios";

export interface AuraPlanItem {
  plu: number;
  action: AuraPlanAction;
  reason: string;
  /** Registro a mandar con 2005 (orden de escritura), o null si no se manda. */
  record: string | null;
  /** Cómo debería releerse con 5005 si la balanza lo guardó bien. */
  expectedReadBack: string | null;
}

export interface AuraPlanUpdate {
  plu: number;
  priceRaw: number;
  byWeight: boolean;
  name?: string;
  code?: number;
}

export function planAuraPriceUpdate(scaleRecords: string[], updates: AuraPlanUpdate[]): AuraPlanItem[] {
  const byPlu = new Map(scaleRecords.map((r) => [Number(r.slice(0, 6)), r]));
  return updates.map((u) => {
    if (!Number.isInteger(u.priceRaw) || u.priceRaw < 0 || u.priceRaw > 999999) {
      return { plu: u.plu, action: "omitir", reason: "precio fuera de rango (6 dígitos, pesos enteros)", record: null, expectedReadBack: null };
    }
    const current = byPlu.get(u.plu);
    if (!current) {
      try {
        const record = buildAuraWriteRecord({ plu: u.plu, name: u.name ?? `PLU ${u.plu}`, type: u.byWeight ? "P" : "N", code: u.code ?? u.plu, priceRaw: u.priceRaw });
        return { plu: u.plu, action: "crear", reason: u.byWeight ? "nuevo, por kilo" : "nuevo, por unidad", record, expectedReadBack: auraWriteToReadOrder(record) };
      } catch (err) {
        return { plu: u.plu, action: "omitir", reason: err instanceof Error ? err.message : String(err), record: null, expectedReadBack: null };
      }
    }
    const p = parseAuraPlu(current);
    if (!p) return { plu: u.plu, action: "omitir", reason: "registro de la balanza ilegible", record: null, expectedReadBack: null };
    if (Number(p.priceRaw) === u.priceRaw) return { plu: u.plu, action: "sin_cambios", reason: "ya tiene ese precio", record: null, expectedReadBack: null };
    const record = rewriteWithNewPrice(current, u.priceRaw);
    if (!record) {
      return { plu: u.plu, action: "revisar", reason: `tipo "${p.type}" en la balanza: todavía no se sabe cómo se escribe; no se toca`, record: null, expectedReadBack: null };
    }
    return { plu: u.plu, action: "actualizar", reason: `cambia solo el precio (${p.type === "P" ? "por kilo" : "por unidad"}, código ${p.code} se conserva)`, record, expectedReadBack: auraWriteToReadOrder(record) };
  });
}
