import type { Product } from "@patagonia/domain";
import { parseTicketTotalBarcode, parseWeightBarcode, type ScaleConfig } from "./scale-barcode";

/**
 * Control de balanza en el cierre (migración 104). Lógica pura, testeada.
 *
 * La balanza imprime un "TOTAL DEL DIA" desde el último borrado. La cuenta es:
 *     balanza − tickets anulados  =  lo cobrado en Mostrador con tickets de balanza
 * Si da menos en Mostrador, hubo tickets impresos que no se cobraron por el
 * sistema (o se tiraron sin anularlos).
 */

export interface ScaleControlTotals {
  systemAmount: number;
  systemKg: number;
  systemTickets: number;
  voidedAmount: number;
  voidedKg: number;
  voidedTickets: number;
  shiftCount: number;
}

export interface ScaleReading {
  amount: number;
  kg: number | null;
  tickets: number | null;
}

export interface ScaleComparison {
  /** Lo que la balanza dice que se vendió, menos lo anulado. */
  expectedAmount: number;
  /** Mostrador − esperado. Negativo: faltan cobrar en Mostrador. */
  amountDiff: number;
  expectedKg: number | null;
  kgDiff: number | null;
  expectedTickets: number | null;
  ticketsDiff: number | null;
  /** Coincide (diferencia menor a $1 y, si se cargaron, mismos tickets). */
  ok: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function compareScaleControl(scale: ScaleReading, totals: ScaleControlTotals): ScaleComparison {
  const expectedAmount = round2(scale.amount - totals.voidedAmount);
  const amountDiff = round2(totals.systemAmount - expectedAmount);
  const expectedKg = scale.kg === null ? null : round3(scale.kg - totals.voidedKg);
  const kgDiff = expectedKg === null ? null : round3(totals.systemKg - expectedKg);
  const expectedTickets = scale.tickets === null ? null : scale.tickets - totals.voidedTickets;
  const ticketsDiff = expectedTickets === null ? null : totals.systemTickets - expectedTickets;
  const ok = Math.abs(amountDiff) < 1 && (ticketsDiff === null || ticketsDiff === 0);
  return { expectedAmount, amountDiff, expectedKg, kgDiff, expectedTickets, ticketsDiff, ok };
}

export type ScannedScaleTicket =
  | { kind: "label"; plu: string; product: Product; weightKg: number | null; amount: number }
  | { kind: "total"; amount: number };

/**
 * Qué dice un ticket de balanza escaneado (para anularlo). Etiqueta de peso:
 * el importe se calcula al precio del sistema (igual que al venderlo).
 * Devuelve null si el código no es de la balanza o su PLU no es de ningún
 * producto (igual que Mostrador al vender: un código común de góndola también
 * tiene 13 dígitos).
 */
export function describeScaleTicket(raw: string, config: ScaleConfig, products: Product[]): ScannedScaleTicket | null {
  const code = raw.trim();
  if (!code) return null;
  const total = parseTicketTotalBarcode(code);
  if (total !== null && !products.some((p) => p.code === code)) return { kind: "total", amount: total };

  const scanned = parseWeightBarcode(code, config);
  if (!scanned) return null;
  const product = products.find((p) => p.code === scanned.plu);
  if (!product) return null;
  if (scanned.kind === "weight") {
    return { kind: "label", plu: scanned.plu, product, weightKg: scanned.weightKg, amount: round2(scanned.weightKg * product.priceRetail) };
  }
  return {
    kind: "label",
    plu: scanned.plu,
    product,
    weightKg: product.unit === "kg" && product.priceRetail > 0 ? round3(scanned.amount / product.priceRetail) : null,
    amount: scanned.amount
  };
}

/**
 * El "TOTAL DE VENTAS" tal cual lo imprime la Kretz: "962812.52$", con PUNTO decimal.
 * Real (Carnes Patagonia, 2026-10-08): se cargaba con parseAmount, que toma el punto
 * como miles, y quedaba $96.281.252 en vez de $962.812,52.
 * - Con coma: formato argentino ("962.812,52").
 * - Un solo punto con 1 o 2 cifras al final: decimal de la balanza ("962812.52").
 * - Si no: miles con punto ("962.812") o número entero.
 */
export function parseScaleAmount(raw: string): number {
  const s = raw.trim().replace(/\$/g, "").replace(/\s/g, "");
  if (s === "") return NaN;
  if (s.includes(",")) return Number(s.replace(/\./g, "").replace(",", "."));
  if (/^\d+\.\d{1,2}$/.test(s)) return Number(s);
  return Number(s.replace(/\./g, ""));
}

/** "85.112kg" o "85,112": la balanza siempre imprime kilos con decimal. */
export function parseScaleKg(raw: string): number {
  const s = raw.trim().toLowerCase().replace(/kg$/, "").replace(/\s/g, "").replace(",", ".");
  return s === "" ? NaN : Number(s);
}

/**
 * Si al copiar se perdió el punto ("96281252" en vez de 962812.52, "85112" en vez de 85.112),
 * el número queda 100 o 1000 veces más grande que lo vendido en Mostrador. Devuelve el valor
 * corregido para sugerirlo, o null si el número es razonable. Real: 7 cierres así (2026-09-30 a 10-08).
 */
export function suggestScaleCorrection(value: number, system: number, divisor: 100 | 1000): number | null {
  if (!Number.isFinite(value) || !(system > 0) || value <= system * 20) return null;
  const fixed = Math.round((value / divisor) * 1000) / 1000;
  return fixed >= system * 0.3 && fixed <= system * 5 ? fixed : null;
}
