// Ingreso de stock por escaneo (migración 204, pedido de Carplat 18/11/2026). Lógica pura (ver stock-entry.test.ts).
//
// Cada escaneo es un renglón: una caja con etiqueta del frigorífico (producto + kilos de la caja), una etiqueta de la
// balanza del local (producto + kilos) o el código de un producto, al que después se le escriben los kilos.

import type { Product } from "@patagonia/domain";
import { productForDigits, readAnyBox, type BoxLabelFormat } from "../sale/box-label";
import { resolveScan } from "../sale/scan-resolve";
import type { ScaleConfig } from "../sale/scale-barcode";

export interface EntryLine {
  key: string;
  productId: string;
  name: string;
  unit: Product["unit"];
  quantity: number;
  /** El código escaneado (caja o etiqueta). Vacío si se escribió a mano. */
  code: string;
  /** Suma 1 caja/paquete al producto (con la pantalla "Paquetes"). */
  box: boolean;
}

export type EntryScan =
  | { type: "line"; line: Omit<EntryLine, "key">; detail: string }
  /** Código de un producto: falta escribir los kilos (o las unidades). */
  | { type: "product"; product: Product }
  | { type: "search"; matches: Product[] }
  | { type: "error"; message: string };

const plain = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const fmtKg = (n: number) => `${n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 3 })} kg`;
export const fmtQty = (n: number, unit: Product["unit"]) => (unit === "kg" ? fmtKg(n) : `${n.toLocaleString("es-AR")} u.`);

/** ¿Este renglón suma una caja? Con "Paquetes" prendido, cada renglón por kilo es una caja o paquete. */
export function countsAsBox(unit: Product["unit"], packages: boolean): boolean {
  return packages && unit === "kg";
}

/**
 * Qué es lo que se escaneó o escribió. Primero el código exacto de un producto, después la caja del frigorífico
 * (salvo que sea una etiqueta de balanza de un producto que existe, como en Mostrador), después la etiqueta de la
 * balanza, y si nada de eso, se busca por nombre.
 */
export function resolveEntryScan(rawInput: string, products: Product[], formats: BoxLabelFormat[], scaleConfig: ScaleConfig, packages: boolean): EntryScan {
  const raw = rawInput.trim();
  if (!raw) return { type: "search", matches: [] };
  const active = products.filter((p) => p.active ?? true);

  const exact = active.find((p) => p.code === raw) ?? active.find((p) => p.code.toLowerCase() === raw.toLowerCase());
  if (exact) return { type: "product", product: exact };

  const scale = resolveScan(raw, active, scaleConfig);

  const box = formats.length > 0 && scale.type !== "label" ? readAnyBox(raw, formats) : null;
  if (box) {
    const product = productForDigits(box.productDigits, active, box.format.productMap);
    if (!product) {
      return {
        type: "error",
        message: `Es una caja con el número ${box.productDigits} y ${fmtKg(box.weightKg)}, pero ese número todavía no tiene un producto. No se agregó: en Mostrador → engranaje → Etiquetas de cajas, tocá "Asociar", escaneá la caja y elegí el producto.`
      };
    }
    const quantity = product.unit === "kg" ? Math.round(box.weightKg * 1000) / 1000 : 1;
    return {
      type: "line",
      line: { productId: product.id, name: product.name, unit: product.unit, quantity, code: box.code, box: packages },
      detail: `${product.name}: ${fmtQty(quantity, product.unit)} (caja)`
    };
  }

  if (scale.type === "label") {
    const p = scale.product;
    return {
      type: "line",
      line: { productId: p.id, name: p.name, unit: p.unit, quantity: scale.quantity, code: raw, box: countsAsBox(p.unit, packages) },
      detail: `${p.name}: ${fmtQty(scale.quantity, p.unit)} (etiqueta de balanza)`
    };
  }
  if (scale.type === "product") return { type: "product", product: scale.product };
  if (scale.type === "error") return { type: "error", message: scale.message };

  if (/^\d{8,}$/.test(raw)) {
    return { type: "error", message: `No se reconoce el código ${raw}: no es un producto, ni una caja, ni una etiqueta de la balanza. No se agregó nada.` };
  }
  const words = plain(raw).split(/\s+/).filter(Boolean);
  const matches = active.filter((p) => {
    const name = plain(`${p.name} ${p.code}`);
    return words.every((w) => name.includes(w));
  });
  return { type: "search", matches: matches.slice(0, 8) };
}

export interface EntryTotals {
  lines: number;
  kg: number;
  boxes: number;
  /** Por producto, en el orden en que aparecieron: kilos (o unidades) y cajas. */
  byProduct: { productId: string; name: string; unit: Product["unit"]; quantity: number; boxes: number }[];
}

export function entryTotals(lines: EntryLine[]): EntryTotals {
  const map = new Map<string, EntryTotals["byProduct"][number]>();
  let kg = 0;
  let boxes = 0;
  for (const l of lines) {
    const row = map.get(l.productId) ?? { productId: l.productId, name: l.name, unit: l.unit, quantity: 0, boxes: 0 };
    row.quantity = Math.round((row.quantity + l.quantity) * 1000) / 1000;
    if (l.box) row.boxes += 1;
    map.set(l.productId, row);
    if (l.unit === "kg") kg += l.quantity;
    if (l.box) boxes += 1;
  }
  return { lines: lines.length, kg: Math.round(kg * 1000) / 1000, boxes, byProduct: [...map.values()] };
}
