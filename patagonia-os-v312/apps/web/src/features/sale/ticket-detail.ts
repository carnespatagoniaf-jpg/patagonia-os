/**
 * "¿Qué productos lleva este ticket?" — para las balanzas que imprimen un solo código, el del TOTAL (Kretz Aura de
 * fábrica; real: Pollo y mar 15/10, "02 ART. TOTAL = 4758.00", código 2099804758000).
 *
 * La cajera elige cada producto del papel y escribe su IMPORTE (el número impreso a la derecha). Patagonia calcula
 * los kilos (importe ÷ precio de Patagonia, al gramo) o las unidades, controla que la suma dé EXACTO el total del
 * código, y recién ahí carga los productos: se cobra lo que cobró la balanza y el stock baja al cobrar.
 * Lógica pura (sin Supabase), probada.
 */

export interface DetailProduct {
  id: string;
  name: string;
  unit: string;
  priceRetail: number;
}

export interface DetailRowInput {
  product: DetailProduct | null;
  /** Importe impreso en el papel para ese producto, en pesos. */
  amount: number;
}

export interface DetailRow {
  product: DetailProduct;
  amount: number;
  /** Kilos (al gramo) o unidades (entero). */
  quantity: number;
}

export type DetailCheck =
  | { ok: true; rows: DetailRow[] }
  | { ok: false; reason: string; missing: number };

const cents = (n: number) => Math.round(n * 100);

/** Kilos o unidades que corresponden a ese importe con el precio de Patagonia. null si no se puede saber. */
export function quantityFor(product: DetailProduct, amount: number): number | null {
  if (!(product.priceRetail > 0) || !(amount > 0)) return null;
  const raw = amount / product.priceRetail;
  if (product.unit === "kg") {
    const kg = Math.round(raw * 1000) / 1000;
    return kg > 0 ? kg : null;
  }
  const units = Math.round(raw);
  // Por unidad: el importe tiene que ser un número exacto de unidades (con un peso de tolerancia por redondeo).
  return units >= 1 && Math.abs(units * product.priceRetail - amount) <= 1 ? units : null;
}

export function checkTicketDetail(total: number, inputs: DetailRowInput[]): DetailCheck {
  const filled = inputs.filter((r) => r.product || r.amount > 0);
  const sum = filled.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0);
  const missing = (cents(total) - cents(sum)) / 100;
  if (filled.length === 0) return { ok: false, reason: "Elegí los productos del ticket y escribí el importe de cada uno.", missing };
  const rows: DetailRow[] = [];
  for (const r of filled) {
    if (!r.product) return { ok: false, reason: "Falta elegir el producto en una línea.", missing };
    if (!(r.amount > 0)) return { ok: false, reason: `Falta el importe de ${r.product.name}.`, missing };
    const quantity = quantityFor(r.product, r.amount);
    if (quantity === null) {
      return {
        ok: false,
        reason: r.product.priceRetail > 0 ? `El importe de ${r.product.name} no da unidades enteras con su precio ($${r.product.priceRetail}).` : `${r.product.name} no tiene precio en Patagonia: cargalo en Stock.`,
        missing
      };
    }
    rows.push({ product: r.product, amount: r.amount, quantity });
  }
  if (missing !== 0) {
    return { ok: false, reason: missing > 0 ? `Faltan $${missing.toLocaleString("es-AR")} para llegar al total del ticket.` : `Te pasaste $${(-missing).toLocaleString("es-AR")} del total del ticket.`, missing };
  }
  return { ok: true, rows };
}
