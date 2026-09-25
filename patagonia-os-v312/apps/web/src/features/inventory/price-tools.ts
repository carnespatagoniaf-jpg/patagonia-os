import type { Product } from "@patagonia/domain";
import { marginPercent } from "@patagonia/domain";

// Cálculo puro de actualizaciones masivas de precios (inflación). Sin Supabase
// ni React a propósito: lo que se muestra en la vista previa es EXACTAMENTE lo
// que se manda a guardar, y se puede probar solo (price-tools.test.ts).

export type PriceMode = "percent" | "margin";
export type PriceRounding = 0 | 10 | 50 | 100;

export type PlanProduct = Pick<Product, "id" | "code" | "name" | "unit" | "cost" | "priceRetail"> & {
  categoryId?: string;
  active?: boolean;
};

export interface PricePlanOptions {
  mode: PriceMode;
  /** Modo "percent": +8 sube 8%, -5 baja 5%. */
  percent: number;
  /** Modo "margin": margen mínimo (sobre el costo) al que se quiere llegar. */
  targetMargin: number;
  rounding: PriceRounding;
  /** Modo "percent": aplicar el mismo % también al costo. */
  alsoCost: boolean;
  /** "" = todos los productos activos. */
  categoryId: string;
}

export interface PricePlanRow {
  id: string;
  code: string;
  name: string;
  unit: Product["unit"];
  oldPrice: number;
  newPrice: number;
  oldCost: number;
  newCost: number;
  oldMargin: number;
  newMargin: number;
}

export const MAX_PERCENT = 500;
export const LOW_MARGIN_ALERT = 15;

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** Redondea al múltiplo más cercano (0 = solo centavos). */
export function roundPrice(value: number, step: PriceRounding): number {
  if (step === 0) return round2(value);
  return Math.round(value / step) * step;
}

/** Redondea siempre hacia arriba: para no quedar por debajo del margen buscado. */
export function roundPriceUp(value: number, step: PriceRounding): number {
  if (step === 0) return Math.ceil(value * 100 - 1e-9) / 100;
  return Math.ceil(value / step - 1e-9) * step;
}

/** null si las opciones son válidas; si no, el motivo en castellano. */
export function validatePlanOptions(options: PricePlanOptions): string | null {
  if (options.mode === "percent") {
    if (!Number.isFinite(options.percent) || options.percent === 0) return "Ingresá el porcentaje (por ejemplo 8 para subir 8%).";
    if (options.percent <= -100 || options.percent > MAX_PERCENT) return `El porcentaje tiene que estar entre -99 y ${MAX_PERCENT}.`;
  } else {
    if (!Number.isFinite(options.targetMargin) || options.targetMargin < 0) return "Ingresá el margen mínimo (por ejemplo 30).";
    if (options.targetMargin > 1000) return "El margen mínimo no puede pasar de 1000%.";
  }
  return null;
}

export function buildPricePlan(products: PlanProduct[], options: PricePlanOptions): PricePlanRow[] {
  if (validatePlanOptions(options)) return [];

  const rows: PricePlanRow[] = [];
  for (const product of products) {
    if (product.active === false) continue;
    if (options.categoryId && product.categoryId !== options.categoryId) continue;

    const oldPrice = product.priceRetail;
    const oldCost = product.cost;
    let newPrice = oldPrice;
    let newCost = oldCost;

    if (options.mode === "percent") {
      const factor = 1 + options.percent / 100;
      if (oldPrice > 0) newPrice = roundPrice(oldPrice * factor, options.rounding);
      if (options.alsoCost && oldCost > 0) newCost = round2(oldCost * factor);
    } else {
      // Solo sube los que están por debajo del margen buscado; nunca baja precios.
      if (oldCost > 0) {
        const target = roundPriceUp(oldCost * (1 + options.targetMargin / 100), options.rounding);
        if (target > oldPrice) newPrice = target;
      }
    }

    if (newPrice === oldPrice && newCost === oldCost) continue;

    rows.push({
      id: product.id,
      code: product.code,
      name: product.name,
      unit: product.unit,
      oldPrice,
      newPrice,
      oldCost,
      newCost,
      oldMargin: marginPercent(oldCost, oldPrice),
      newMargin: marginPercent(newCost, newPrice)
    });
  }
  return rows;
}

/** Productos activos con costo cargado cuyo margen está por debajo del umbral. */
export function lowMarginProducts(products: PlanProduct[], threshold = LOW_MARGIN_ALERT): PlanProduct[] {
  return products.filter((p) => p.active !== false && p.cost > 0 && p.priceRetail > 0 && marginPercent(p.cost, p.priceRetail) < threshold);
}

export interface PurchaseCostLine {
  productId?: string;
  unit: "kg" | "unit";
  unitPrice: number;
}

export interface PurchaseCostChange {
  id: string;
  name: string;
  priceRetail: number;
  oldCost: number;
  newCost: number;
  newMargin: number;
}

/** Costos nuevos que se desprenden de una compra: solo ítems con producto, en la
 * misma unidad que el producto (no se mezcla kg con unidad) y con un precio
 * distinto al costo actual. Si un producto aparece dos veces, vale el último. */
export function costChangesFromPurchase(products: PlanProduct[], lines: PurchaseCostLine[]): PurchaseCostChange[] {
  const byProduct = new Map<string, PurchaseCostChange>();
  for (const line of lines) {
    if (!line.productId || !(line.unitPrice > 0)) continue;
    const product = products.find((p) => p.id === line.productId);
    if (!product || product.unit !== line.unit) continue;
    const newCost = round2(line.unitPrice);
    if (newCost === product.cost) {
      byProduct.delete(product.id);
      continue;
    }
    byProduct.set(product.id, {
      id: product.id,
      name: product.name,
      priceRetail: product.priceRetail,
      oldCost: product.cost,
      newCost,
      newMargin: marginPercent(newCost, product.priceRetail)
    });
  }
  return [...byProduct.values()];
}
