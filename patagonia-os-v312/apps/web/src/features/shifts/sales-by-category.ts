// Reportes → "Por categoría": agrupa lo vendido por producto (sales_by_product,
// migración 114) en categorías. Pura, para probarla con node --test.

export interface ProductSalesRow {
  productId: string | null;
  productName: string;
  productCode: string | null;
  unit: "kg" | "unit" | "box" | null;
  categoryId: string | null;
  categoryName: string | null;
  quantity: number;
  amount: number;
  lines: number;
}

export interface CategorySales {
  key: string;
  name: string;
  /** Líneas sin producto (ticket de total de la balanza o "vender algo sin código"). */
  unidentified: boolean;
  amount: number;
  kg: number;
  units: number;
  /** % del total vendido en el período. */
  pct: number;
  products: ProductSalesRow[];
}

export const UNIDENTIFIED_KEY = "sin-producto";

export function groupSalesByCategory(rows: ProductSalesRow[]): { total: number; categories: CategorySales[] } {
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const byKey = new Map<string, CategorySales>();
  for (const row of rows) {
    const unidentified = row.productId === null;
    const key = unidentified ? UNIDENTIFIED_KEY : row.categoryId ?? "sin-categoria";
    const name = unidentified ? "Sin producto" : row.categoryName ?? "Sin categoría";
    const group = byKey.get(key) ?? { key, name, unidentified, amount: 0, kg: 0, units: 0, pct: 0, products: [] };
    group.amount += row.amount;
    if (row.unit === "kg") group.kg += row.quantity;
    else if (row.unit) group.units += row.quantity;
    group.products.push(row);
    byKey.set(key, group);
  }
  const categories = [...byKey.values()].map((g) => ({
    ...g,
    amount: Math.round(g.amount * 100) / 100,
    kg: Math.round(g.kg * 1000) / 1000,
    units: Math.round(g.units * 1000) / 1000,
    pct: total > 0 ? Math.round((g.amount / total) * 1000) / 10 : 0,
    products: [...g.products].sort((a, b) => b.amount - a.amount)
  }));
  // De mayor a menor; "Sin producto" siempre al final para que se vea aparte.
  categories.sort((a, b) => Number(a.unidentified) - Number(b.unidentified) || b.amount - a.amount);
  return { total: Math.round(total * 100) / 100, categories };
}
