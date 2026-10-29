import { marginPercent, priceFromMargin } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";

/**
 * Costo / Margen % / Precio venta de la ficha de Stock (lógica pura, testeada en product-pricing.test.ts).
 * El margen es sobre el costo, igual que en el resto del sistema: costo $6.000 + 35% = $8.100.
 */

export interface PricingFields {
  cost: string;
  margin: string;
  priceRetail: string;
}

/**
 * El margen NO es plata: "35,5" y "35.5" son 35,5 (con parseAmount "35.5" daba 355) y acepta "35%".
 * Vacío = NaN (no hay margen escrito).
 */
export function parseMargin(raw: string): number {
  const text = raw.trim().replace(/%/g, "").trim().replace(",", ".");
  if (!text) return NaN;
  return Number(text);
}

/** Vacío = NaN (con parseAmount "" daba 0 y el precio se pisaba con el costo). */
function money(raw: string): number {
  return raw.trim() ? parseAmount(raw) : NaN;
}

/** Plata guardada (17804.35) → texto para editar ("17804,35"): con punto, parseAmount la leía como 1.780.435. */
export function moneyToInput(value: number): string {
  return String(value).replace(".", ",");
}

export function marginToInput(value: number): string {
  return String(value).replace(".", ",");
}

/**
 * Cambió el costo o el margen:
 * - con margen escrito: el precio de venta se calcula solo (costo × (1 + margen/100));
 * - sin margen pero con precio: se muestra el margen que da ese precio.
 */
export function onCostOrMargin<T extends PricingFields>(draft: T, field: "cost" | "margin", value: string): T {
  const next = { ...draft, [field]: value };
  const cost = money(next.cost);
  const margin = parseMargin(next.margin);
  if (Number.isFinite(cost) && cost >= 0 && Number.isFinite(margin)) {
    next.priceRetail = moneyToInput(priceFromMargin(cost, margin));
  } else if (field === "cost" && Number.isFinite(cost) && cost > 0 && !next.margin.trim()) {
    const price = money(next.priceRetail);
    if (Number.isFinite(price)) next.margin = marginToInput(marginPercent(cost, price));
  }
  return next;
}

/** Cambió el precio de venta: con costo cargado se recalcula el margen. */
export function onPrice<T extends PricingFields>(draft: T, value: string): T {
  const next = { ...draft, priceRetail: value };
  const cost = money(next.cost);
  const price = money(value);
  if (Number.isFinite(cost) && cost > 0 && Number.isFinite(price)) {
    next.margin = marginToInput(marginPercent(cost, price));
  }
  return next;
}

/** Código escaneado con la pistola o tipeado: ¿ya es de otro producto? */
export function productWithCode<P extends { id: string; code: string }>(products: P[], code: string, exceptId?: string): P | undefined {
  const wanted = code.trim();
  if (!wanted) return undefined;
  return products.find((p) => p.id !== exceptId && p.code.trim() === wanted);
}
