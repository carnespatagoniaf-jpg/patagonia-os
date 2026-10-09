// Reportes → "Por categoría": agrupa lo vendido por producto (sales_by_product,
// migraciones 114 y 115) en categorías, con ganancia, margen y comparación con
// el período anterior. Pura, para probarla con node --test.

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
  /** Costo de lo vendido: el guardado en cada venta o, en ventas viejas, el costo actual del producto. */
  cost: number;
  /** Renglones sin costo guardado (ventas anteriores a la migración 115): su ganancia es estimada. */
  estimatedCostLines: number;
  /** Renglones de productos con costo 0 o sin cargar: su ganancia sale de más. */
  missingCostLines: number;
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
  /** Ganancia (vendido − costo). null para "Sin producto": no se sabe qué costó. */
  profit: number | null;
  /** Margen sobre el costo, igual que en Stock. null sin costo. */
  marginPct: number | null;
  products: ProductSalesRow[];
}

export const UNIDENTIFIED_KEY = "sin-producto";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Margen sobre el costo ((vendido − costo) / costo), como en Stock. */
export function marginOnCost(amount: number, cost: number): number | null {
  return cost > 0 ? Math.round(((amount - cost) / cost) * 1000) / 10 : null;
}

export function groupSalesByCategory(rows: ProductSalesRow[]): {
  total: number;
  profit: number;
  estimatedCostLines: number;
  missingCostProducts: string[];
  categories: CategorySales[];
} {
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const byKey = new Map<string, CategorySales & { cost: number }>();
  for (const row of rows) {
    const unidentified = row.productId === null;
    const key = unidentified ? UNIDENTIFIED_KEY : row.categoryId ?? "sin-categoria";
    const name = unidentified ? "Sin producto" : row.categoryName ?? "Sin categoría";
    const group = byKey.get(key) ?? { key, name, unidentified, amount: 0, kg: 0, units: 0, pct: 0, profit: null, marginPct: null, cost: 0, products: [] };
    group.amount += row.amount;
    group.cost += row.cost;
    if (row.unit === "kg") group.kg += row.quantity;
    else if (row.unit) group.units += row.quantity;
    group.products.push(row);
    byKey.set(key, group);
  }
  const categories: CategorySales[] = [...byKey.values()].map(({ cost, ...g }) => ({
    ...g,
    amount: round2(g.amount),
    kg: Math.round(g.kg * 1000) / 1000,
    units: Math.round(g.units * 1000) / 1000,
    pct: total > 0 ? Math.round((g.amount / total) * 1000) / 10 : 0,
    profit: g.unidentified ? null : round2(g.amount - cost),
    marginPct: g.unidentified ? null : marginOnCost(g.amount, cost),
    products: [...g.products].sort((a, b) => b.amount - a.amount)
  }));
  // De mayor a menor; "Sin producto" siempre al final para que se vea aparte.
  categories.sort((a, b) => Number(a.unidentified) - Number(b.unidentified) || b.amount - a.amount);
  const identified = rows.filter((r) => r.productId !== null);
  return {
    total: round2(total),
    profit: round2(identified.reduce((sum, r) => sum + r.amount - r.cost, 0)),
    estimatedCostLines: identified.reduce((sum, r) => sum + r.estimatedCostLines, 0),
    missingCostProducts: identified.filter((r) => r.missingCostLines > 0).map((r) => r.productName),
    categories
  };
}

/** Variación % frente al período anterior. null si antes no se vendió nada (no hay con qué comparar). */
export function changePct(current: number, previous: number): number | null {
  if (!(previous > 0)) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Período anterior del mismo largo: del 8 al 14 → del 1 al 7. Fechas "AAAA-MM-DD". */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const day = 86_400_000;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const length = Math.round((end - start) / day) + 1;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(start - length * day), to: iso(start - day) };
}
