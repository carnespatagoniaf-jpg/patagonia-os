import { parseAuraPlu } from "./aura-plu";

/**
 * Plan de actualización de PRECIOS para la Kretz Aura, solo sobre lo que la
 * evidencia real permite (no se usa en la app todavía; no envía nada).
 *
 * Lo comprobado con la balanza real (2026-10-02, 5 escrituras):
 * - 2005 guarda nombre, precio (pesos enteros), tara y validez tal cual.
 * - La letra queda SIEMPRE "D" y el código SIEMPRE 0.
 * - "D" se vende por kilo (tickets T.0029 y T.0030).
 * Entonces:
 * - Producto con letra "D" en la balanza: actualizar el precio no cambia cómo se
 *   vende. Lo único que se pierde es su código (queda en 0). → "actualizar"
 * - Letra "P": pasaría a "D". Los dos parecen por kilo, pero no se sabe qué
 *   diferencia hay entre P y D. → "riesgo" (no se manda sin decisión del dueño)
 * - Letra "N" o "C": pasaría a "D" = por kilo, y se vendería mal. → "omitir"
 * - PLU que no existe en la balanza: se crearía como "D" = por kilo. Solo sirve
 *   para productos por kilo. → "crear_por_kilo", o "omitir" si es por unidad.
 */

export type AuraPlanAction = "actualizar" | "riesgo" | "omitir" | "crear_por_kilo" | "sin_cambios";

export interface AuraPlanItem {
  plu: number;
  action: AuraPlanAction;
  reason: string;
  /** Registro a mandar con 2005 (null si no se manda). */
  record: string | null;
  /** Lo que se espera que quede guardado según lo observado (letra D, código 0). */
  expectedStored: string | null;
}

/** Lo que la Aura real hizo con cada 2005: posición 22 → "D", 23-28 → "000000", el resto igual. */
export function observedAuraStore(sent: string): string {
  return sent.slice(0, 22) + "D" + "000000" + sent.slice(29);
}

export function planAuraPriceUpdate(
  scaleRecords: string[],
  updates: { plu: number; priceRaw: number; byWeight: boolean; name?: string }[]
): AuraPlanItem[] {
  const byPlu = new Map(scaleRecords.map((r) => [Number(r.slice(0, 6)), r]));
  return updates.map((u) => {
    if (!Number.isInteger(u.priceRaw) || u.priceRaw < 0 || u.priceRaw > 999999) {
      return { plu: u.plu, action: "omitir", reason: "precio fuera de rango (6 dígitos, pesos enteros)", record: null, expectedStored: null };
    }
    const current = byPlu.get(u.plu);
    const price = String(u.priceRaw).padStart(6, "0");
    if (!current) {
      if (!u.byWeight) return { plu: u.plu, action: "omitir", reason: "producto por unidad: la Aura lo guardaría por kilo", record: null, expectedStored: null };
      const name = (u.name ?? "").toUpperCase().slice(0, 16).padEnd(16, " ");
      const record = `${String(u.plu).padStart(6, "0")}${name}D000000${price}0000000`;
      return { plu: u.plu, action: "crear_por_kilo", reason: "no existe en la balanza: se crea por kilo, sin código", record, expectedStored: observedAuraStore(record) };
    }
    const p = parseAuraPlu(current);
    if (!p) return { plu: u.plu, action: "omitir", reason: "registro de la balanza ilegible", record: null, expectedStored: null };
    if (p.priceRaw === price) return { plu: u.plu, action: "sin_cambios", reason: "ya tiene ese precio", record: null, expectedStored: null };
    // Se cambia SOLO el precio: nombre, letra, código, tara y validez van tal cual estaban.
    const record = current.slice(0, 29) + price + current.slice(35);
    if (p.type === "D") {
      return { plu: u.plu, action: "actualizar", reason: p.code === "000000" ? "por kilo (D): cambia solo el precio" : `por kilo (D): cambia el precio; su código ${p.code} quedaría en 0`, record, expectedStored: observedAuraStore(record) };
    }
    if (p.type === "P") {
      return { plu: u.plu, action: "riesgo", reason: "letra P: quedaría en D; no se sabe qué diferencia hay entre P y D", record, expectedStored: observedAuraStore(record) };
    }
    return { plu: u.plu, action: "omitir", reason: `letra ${p.type}: quedaría en D = por kilo (hoy se vende distinto)`, record: null, expectedStored: null };
  });
}
