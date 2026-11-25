import type { TicketLine } from "./sale-model";

/**
 * Kilos que casi seguro son GRAMOS escritos como kilos. REAL El corte argentino 24-25/11/2026: "1035" en BIFE ANCHO,
 * "2465" en ASADO, "4070" en VACIO, "950" en CUADRIL → ventas de $13 a $145 millones que se cobraron así.
 * Una venta de mostrador de más de esto se pregunta antes de cobrar (nunca se corrige sola).
 */
export const MAX_COUNTER_SALE_KG = 100;

export interface SuspiciousKg {
  key: string;
  name: string;
  quantity: number;
  /** Lo que sería si fueran gramos. */
  asGrams: number;
}

/** Renglones por kg con una cantidad que no tiene sentido en un mostrador. Puro. */
export function suspiciousKgLines(cart: TicketLine[]): SuspiciousKg[] {
  return cart
    .filter((l) => l.unit === "kg" && l.quantity > MAX_COUNTER_SALE_KG)
    .map((l) => ({ key: l.key, name: l.name, quantity: l.quantity, asGrams: Math.round(l.quantity) / 1000 }));
}

/** Pasa esos renglones de gramos a kilos (4070 → 4,070). Puro. */
export function gramsToKg(cart: TicketLine[], keys: string[]): TicketLine[] {
  const set = new Set(keys);
  return cart.map((l) => (set.has(l.key) && l.unit === "kg" ? { ...l, quantity: Math.round(l.quantity) / 1000 } : l));
}

const kg = (q: number) => q.toLocaleString("es-AR", { maximumFractionDigits: 3 });

export function suspiciousKgQuestion(lines: SuspiciousKg[]): string {
  const list = lines.map((l) => `• ${l.name}: ${kg(l.quantity)} kg`).join("\n");
  const fixed = lines.map((l) => `${l.name} ${kg(l.asGrams)} kg`).join(", ");
  return `Estos kilos son demasiados para una venta de mostrador:\n${list}\n\n¿Escribiste los gramos? Aceptar = pasarlos a kilos (${fixed}).\nCancelar = dejarlos como están.`;
}
