import type { Product } from "@patagonia/domain";

/**
 * Listas de precios (migración 166): "Mayorista" = minorista ± % o costo + %, redondeado a pesos.
 * El minorista es products.price_retail (no es una lista guardada). Lógica pura, testeada en
 * price-lists.test.ts; la misma cuenta está en SQL (price_list_price / product_list_prices_view):
 * si se cambia una, cambiar la otra.
 */

export interface PriceList {
  id: string;
  name: string;
  base: "retail" | "cost";
  pct: number;
  active: boolean;
}

/** Precio que sale de la regla de la lista (sin precio a mano). Las presentaciones van a minorista. */
export function rulePrice(list: Pick<PriceList, "base" | "pct">, cost: number, priceRetail: number, isPresentation = false): number {
  if (isPresentation) return priceRetail;
  if (list.base === "cost") {
    if (!(cost > 0)) return priceRetail;
    return Math.round(cost * (1 + list.pct / 100));
  }
  return Math.round(priceRetail * (1 + list.pct / 100));
}

/** "minorista −10%" / "costo + 20%". */
export function ruleLabel(list: Pick<PriceList, "base" | "pct">): string {
  const pct = Math.abs(list.pct).toLocaleString("es-AR", { maximumFractionDigits: 2 });
  const sign = list.pct < 0 ? "−" : "+";
  return list.base === "cost" ? `costo ${sign} ${pct}%` : list.pct === 0 ? "igual al minorista" : `minorista ${sign} ${pct}%`;
}

/** Precio del producto en la lista (o minorista si no hay lista o el producto no tiene precio en ella). */
export function productPrice(product: Pick<Product, "priceRetail" | "listPrices">, listId: string | null | undefined): number {
  if (!listId) return product.priceRetail;
  return product.listPrices?.[listId]?.price ?? product.priceRetail;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Etiqueta de balanza con importe (la balanza cobró a minorista): con lista se cobra en proporción,
 * igual que pos_list_scale_amount en SQL.
 */
export function scaleAmountForList(scaleAmount: number, retailPrice: number, listPrice: number): number {
  if (!(retailPrice > 0) || listPrice === retailPrice) return scaleAmount;
  return round2((scaleAmount * listPrice) / retailPrice);
}

/** Lista activa por id (ignora las desactivadas: se cobran a minorista). */
export function activeList(lists: PriceList[], listId: string | null | undefined): PriceList | undefined {
  if (!listId) return undefined;
  return lists.find((l) => l.id === listId && l.active);
}
