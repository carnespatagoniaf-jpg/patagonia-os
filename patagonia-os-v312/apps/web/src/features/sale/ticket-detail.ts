import type { Product } from "@patagonia/domain";
import type { TicketLine } from "./sale-model";

/**
 * Detallar un ticket de TOTAL de la balanza (Kretz Aura y cualquier balanza cuyo ticket de varios productos trae SOLO
 * el importe total; ver docs/BALANZAS_DIAGNOSTICO_2026-10-19.md §4).
 *
 * Por qué así: la Aura no imprime el código de cada producto en el ticket de suma (manual §7.1.7; el 1080 lo rechazó
 * la balanza real de Pollo y mar) y no hay comando documentado que devuelva el detalle de un ticket. Lo único que
 * tiene el detalle es el papel impreso. Entonces, cuando el cajero quiere que baje el stock:
 *
 * - el TOTAL queda como una línea "Ticket de balanza" con lo que FALTA detallar;
 * - por cada producto del papel elige el producto y escribe el importe impreso; esa línea sale del total;
 * - el importe cobrado NUNCA cambia (la suma siempre es el TOTAL escaneado);
 * - los kilos que se descuentan = importe ÷ precio de Patagonia (los precios de la balanza son los de Patagonia
 *   porque se mandan desde acá; mismo criterio que la etiqueta Pre-Empaque);
 * - es opcional: si no se detalla, se cobra igual el TOTAL (sin stock), como decidió el dueño el 15/10.
 *
 * Control de balanza del cierre (migración 104): el ticket cuenta UNA vez. Las líneas del detalle van con
 * scale_tickets = 0 (migración 134) y, si el total se detalla entero, la primera pasa a contar el ticket.
 */

export const DETAIL_ROUNDING = 0.5;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export type DetailResult = { ok: true; cart: TicketLine[]; done: boolean; remaining: number; line: TicketLine } | { ok: false; reason: string };

/** Lo que falta detallar del TOTAL (la línea "Ticket de balanza"), o null si ya no está. */
export function detailRemaining(cart: TicketLine[], totalKey: string): number | null {
  const line = cart.find((l) => l.key === totalKey);
  return line ? round2(line.unitPrice * line.quantity) : null;
}

export function addDetailLine(cart: TicketLine[], totalKey: string, product: Pick<Product, "id" | "name" | "unit" | "priceRetail">, amount: number): DetailResult {
  const total = cart.find((l) => l.key === totalKey);
  if (!total) return { ok: false, reason: "el TOTAL del ticket ya no está en la venta" };
  const remaining = round2(total.unitPrice * total.quantity);
  if (!(amount > 0)) return { ok: false, reason: "escribí el importe de ese producto (el que está impreso en el ticket)" };
  if (amount > remaining + DETAIL_ROUNDING) return { ok: false, reason: `ese importe es más de lo que falta detallar (${remaining.toLocaleString("es-AR")})` };
  if (!(product.priceRetail > 0)) return { ok: false, reason: `"${product.name}" no tiene precio en Patagonia: no se pueden calcular los kilos` };
  const quantity = product.unit === "kg" ? Math.max(0.001, round3(amount / product.priceRetail)) : Math.max(1, Math.round(amount / product.priceRetail));
  const n = cart.filter((l) => l.detailOf === totalKey).length + 1;
  const left = round2(remaining - amount);
  const done = left <= DETAIL_ROUNDING;
  // Con el último producto, los centavos de redondeo van a esa línea: la suma da EXACTO el TOTAL escaneado.
  const lineAmount = done ? round2(amount + left) : amount;
  const line: TicketLine = {
    key: `${product.id}|detalle|${totalKey}|${n}`,
    kind: "product",
    productId: product.id,
    name: product.name,
    unit: product.unit,
    quantity,
    unitPrice: lineAmount / quantity,
    source: "scale",
    scaleTickets: 0,
    scaleAmount: lineAmount,
    scaleTicket: `${totalKey}#${n}`,
    detailOf: totalKey
  };
  let next = [...cart, line];
  if (done) {
    // El TOTAL quedó detallado entero: sale su línea y el ticket lo cuenta la primera del detalle.
    const first = next.find((l) => l.detailOf === totalKey);
    next = next.filter((l) => l.key !== totalKey).map((l) => (l === first ? { ...l, scaleTickets: 1 } : l));
  } else {
    next = next.map((l) => (l.key === totalKey ? { ...l, quantity: 1, unitPrice: left } : l));
  }
  return { ok: true, cart: next, done, remaining: done ? 0 : left, line };
}

/** Sacar una línea de un ticket detallado (o su TOTAL) saca el ticket entero: van juntas. */
export function detailGroupKeys(cart: TicketLine[], key: string): string[] {
  const line = cart.find((l) => l.key === key);
  const group = line?.detailOf ?? (cart.some((l) => l.detailOf === key) ? key : null);
  if (!group) return [key];
  return cart.filter((l) => l.key === group || l.detailOf === group).map((l) => l.key);
}
