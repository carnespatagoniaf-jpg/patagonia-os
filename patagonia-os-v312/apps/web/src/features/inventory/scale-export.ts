import type { Product } from "@patagonia/domain";
import type { ProductCategory } from "./product-categories-service";

/**
 * Exporta el catálogo en el formato que pide el importador de PLU por
 * Excel/CSV del software de PC de Kretz (Simplex/iTegra) -- los campos
 * encontrados son PLU NAME, PLU NUMBER, PLU CODE, DEPARTMENT CODE, PRICE,
 * PLU TYPE, separados por punto y coma. No se pudo confirmar el orden
 * exacto de columnas ni los valores esperados de DEPARTMENT CODE/PLU TYPE
 * contra el software real (el instructivo de Kretz es solo capturas de
 * pantalla) -- probar este archivo contra el importador real y ajustar acá
 * si algo no calza, antes de asumir que el resto del mapeo también está mal.
 *
 * Supuestos hechos a ojo, a confirmar:
 * - PLU NUMBER y PLU CODE: se repite el código de Patagonia OS en los dos,
 *   porque no tenemos un código de barras real distinto guardado.
 * - DEPARTMENT CODE: orden de la categoría (sort_order + 1), o 1 si no
 *   tiene categoría asignada.
 * - PLU TYPE: 0 = pesable (kg), 1 = por unidad -- convención común en
 *   básculas, no confirmada específicamente para Kretz.
 */
export function buildScaleExportCsv(products: Product[], categories: ProductCategory[]): string {
  const categoryOrder = new Map(categories.map((c) => [c.id, c.sortOrder] as const));
  const header = "PLU NAME;PLU NUMBER;PLU CODE;DEPARTMENT CODE;PRICE;PLU TYPE";
  const rows = products
    .filter((p) => p.active ?? true)
    .map((p) => {
      const departmentCode = (p.categoryId && categoryOrder.get(p.categoryId) !== undefined ? categoryOrder.get(p.categoryId)! + 1 : 1);
      const pluType = p.unit === "kg" ? 0 : 1;
      const price = p.priceRetail.toFixed(2);
      // El nombre no puede llevar ";" (rompería el separador de columnas).
      const safeName = p.name.replace(/;/g, ",");
      return `${safeName};${p.code};${p.code};${departmentCode};${price};${pluType}`;
    });
  return [header, ...rows].join("\r\n");
}

export function downloadScaleExportCsv(products: Product[], categories: ProductCategory[]): void {
  const csv = buildScaleExportCsv(products, categories);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `lista_balanza_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
