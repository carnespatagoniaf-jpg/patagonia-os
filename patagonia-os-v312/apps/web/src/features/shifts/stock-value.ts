import type { Product } from "@patagonia/domain";

/**
 * Reportes → "Stock valorizado" (26/10/2026, a pedido del dueño): cuánto vale la mercadería que hay hoy, de qué es,
 * por categoría y por producto. Lógica pura.
 *   * A costo (lo que se pagó) y a precio de venta (lo que se cobraría), y la diferencia = ganancia posible.
 *   * Las presentaciones (ofertas que usan el stock de otro producto) no se cuentan: su stock es el del principal.
 *   * Los productos en negativo no suman (no hay mercadería): se listan aparte para corregirlos.
 *   * Los que tienen stock y no tienen costo cargado se marcan: su valor a costo sale en 0.
 */

export interface StockValueRow {
  id: string;
  code: string;
  name: string;
  unit: Product["unit"];
  stock: number;
  cost: number;
  price: number;
  costValue: number;
  saleValue: number;
  noCost: boolean;
}

export interface StockValueCategory {
  id: string | null;
  name: string;
  costValue: number;
  saleValue: number;
  rows: StockValueRow[];
}

export interface StockValueReport {
  costValue: number;
  saleValue: number;
  profit: number;
  categories: StockValueCategory[];
  negative: StockValueRow[];
  noCostCount: number;
  productsWithStock: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function stockValueReport(products: Product[], categories: { id: string; name: string }[]): StockValueReport {
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const groups = new Map<string | null, StockValueCategory>();
  const negative: StockValueRow[] = [];
  let noCostCount = 0;

  for (const p of products) {
    if (p.stockSourceId) continue;
    const stock = Number(p.stock) || 0;
    if (stock === 0) continue;
    const cost = Number(p.cost) || 0;
    const price = Number(p.priceRetail) || 0;
    const row: StockValueRow = {
      id: p.id, code: p.code, name: p.name, unit: p.unit, stock, cost, price,
      costValue: round2(stock * cost), saleValue: round2(stock * price), noCost: cost <= 0
    };
    if (stock < 0) {
      negative.push(row);
      continue;
    }
    if (row.noCost) noCostCount++;
    const key = p.categoryId ?? null;
    const group = groups.get(key) ?? { id: key, name: (key && categoryName.get(key)) || "Sin categoría", costValue: 0, saleValue: 0, rows: [] };
    group.rows.push(row);
    group.costValue = round2(group.costValue + row.costValue);
    group.saleValue = round2(group.saleValue + row.saleValue);
    groups.set(key, group);
  }

  const list = [...groups.values()]
    .map((g) => ({ ...g, rows: g.rows.sort((a, b) => b.costValue - a.costValue || b.saleValue - a.saleValue) }))
    .sort((a, b) => b.costValue - a.costValue || b.saleValue - a.saleValue);
  const costValue = round2(list.reduce((s, g) => s + g.costValue, 0));
  const saleValue = round2(list.reduce((s, g) => s + g.saleValue, 0));
  return {
    costValue,
    saleValue,
    profit: round2(saleValue - costValue),
    categories: list,
    negative: negative.sort((a, b) => a.stock - b.stock),
    noCostCount,
    productsWithStock: list.reduce((s, g) => s + g.rows.length, 0)
  };
}
