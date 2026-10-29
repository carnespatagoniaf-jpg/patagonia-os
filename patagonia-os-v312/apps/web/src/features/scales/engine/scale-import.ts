import type { ProductPayload } from "../../import/import-parse";
import type { EngineProduct, ScaleCatalogEntry } from "./types";

/**
 * "Traer productos de la balanza" (pedido 29/10, Quesar delicateses: tiene todo cargado en la balanza y casi nada en
 * Patagonia). Arma las filas para `import_products` SIN actualizar nada: un código que ya existe en Patagonia queda
 * como está. El código en Patagonia es el número de la balanza, igual que al mandar productos (aura-sync, systel-push),
 * así después se reconocen solos. A la balanza no se le escribe nada.
 */

export interface ScaleImportPlan {
  rows: ProductPayload[];
  /** Ya hay un producto con ese código en Patagonia. */
  existing: number;
  /** Lugares vacíos, de ejemplo de fábrica o de prueba de Patagonia. */
  ignored: number;
}

/** Nombre de los productos de ejemplo de fábrica (Report LT nueva: "NOMBRE") y de las pruebas de Patagonia. */
function isPlaceholder(name: string): boolean {
  const n = name.trim().toUpperCase();
  return n === "" || n === "NOMBRE" || n.startsWith("PRUEBA ") || n.startsWith("PATAGONIA PRUEBA") || /^[-.*_ 0]+$/.test(n);
}

export function planScaleImport(catalog: ScaleCatalogEntry[], products: EngineProduct[]): ScaleImportPlan {
  const codes = new Set(products.map((p) => p.code.trim().toLowerCase()));
  const seen = new Set<number>();
  const rows: ProductPayload[] = [];
  let existing = 0;
  let ignored = 0;
  for (const item of [...catalog].sort((a, b) => a.number - b.number)) {
    if (!Number.isInteger(item.number) || item.number < 1 || seen.has(item.number) || isPlaceholder(item.name)) {
      ignored++;
      continue;
    }
    seen.add(item.number);
    const code = String(item.number);
    if (codes.has(code)) {
      existing++;
      continue;
    }
    const price = Number.isFinite(item.price) && item.price > 0 && item.price <= 1_000_000_000 ? Math.round(item.price * 100) / 100 : 0;
    rows.push({ row: rows.length + 1, code, name: item.name.trim(), unit: item.byWeight ? "kg" : "unit", cost: 0, price_retail: price, min_stock: 0, category: "", stock: null, vat_rate: null });
  }
  return { rows, existing, ignored };
}
