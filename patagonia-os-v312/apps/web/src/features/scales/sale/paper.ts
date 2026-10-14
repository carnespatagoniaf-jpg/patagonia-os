import type { Product } from "@patagonia/domain";
import { isWeighed, type DecodedScan, type ScaleLink, type ScaleSaleProfile } from "./profile";

/**
 * Un papel (ticket impreso) de la balanza en Mostrador: los artículos que se escanean y el TOTAL que lo cierra.
 *
 * Reglas (iguales para cualquier marca):
 * - Cada artículo trae producto + cantidad en su código; el producto de Patagonia sale del VÍNCULO
 *   (scale_catalog_items), nunca del parecido del nombre en el momento de cobrar.
 * - El TOTAL cierra el papel:
 *   - la cantidad de artículos tiene que coincidir;
 *   - la suma de los importes tiene que ser EXACTAMENTE el total.
 * - Importe de cada artículo, en este orden:
 *   1. el que trae el código (si lo trae);
 *   2. una única combinación exacta de los precios de lista de la balanza;
 *   3. el que dice el papel, que se tiene que escribir y debe sumar el total.
 *   Nunca proporcional; nunca por importe y hora.
 * - Venta libre (producto genérico de la balanza o vinculado como "libre"): se cobra su importe del papel y NO
 *   descuenta stock.
 *
 * Puro: sin navegador ni Supabase.
 */

export interface PaperItem {
  /** Código de barras escaneado (null = venta libre agregada a mano porque la balanza no imprime su código). */
  barcode: string | null;
  scaleCode: number | null;
  kind: "product" | "libre";
  productId: string | null;
  name: string;
  /** "kg" o "unit" (para mostrar y para el control de unidades enteras). */
  unit: "kg" | "unit";
  quantity: number;
  /** Precios de lista de la balanza para este producto (pesos), para deducir el importe. */
  prices: number[];
  /** Importe conocido: venta libre (escrito del papel) o el que traiga el código. */
  amount: number | null;
}

export interface Paper {
  items: PaperItem[];
}

export const emptyPaper = (): Paper => ({ items: [] });

export type AddResult = { ok: true; paper: Paper; item: PaperItem } | { ok: false; reason: string };

const qtyText = (q: number, unit: "kg" | "unit") => (unit === "kg" ? `${q.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg` : `${q} u.`);

/** Agrega al papel un artículo escaneado. Si algo no es seguro, NO se agrega y se dice por qué. */
export function addScannedItem(paper: Paper, scan: DecodedScan, links: ScaleLink[], products: Product[]): AddResult {
  if (scan.kind !== "item") return { ok: false, reason: "no es el código de un producto de la balanza" };
  const label = scan.item ? `"${scan.item.name.trim()}" (N.º ${scan.code} de la balanza)` : `el producto N.º ${scan.code} de la balanza`;
  if (scan.quantity === null || !(scan.quantity > 0)) return { ok: false, reason: `${label}: ${scan.quantityNote ?? "no trae la cantidad"}. No se agregó.` };
  const link = links.find((l) => l.code === scan.code);
  const weighed = scan.item ? isWeighed(scan.item.saleType) : false;
  const unit: "kg" | "unit" = weighed ? "kg" : "unit";

  if (scan.generic || link?.kind === "libre") {
    const name = scan.item?.name.trim() || "Venta libre de la balanza";
    const item: PaperItem = { barcode: scan.barcode, scaleCode: scan.code, kind: "libre", productId: null, name, unit, quantity: scan.quantity, prices: [], amount: null };
    return { ok: true, paper: { items: [...paper.items, item] }, item };
  }
  if (!scan.item) return { ok: false, reason: `${label} no está en los productos leídos de la balanza. Hay que leer la balanza de nuevo (Stock → Balanza). No se agregó.` };
  if (!link || link.kind === "none" || !link.productId) return { ok: false, reason: `${label} no está vinculado a un producto de Patagonia (Stock → Balanza → Vincular productos). No se agregó.` };
  const product = products.find((p) => p.id === link.productId && (p.active ?? true));
  if (!product) return { ok: false, reason: `${label} está vinculado a un producto que ya no está activo en Patagonia. No se agregó.` };
  if (weighed !== (product.unit === "kg")) {
    return { ok: false, reason: `${label} se vende ${weighed ? "por peso" : "por unidad"} en la balanza y "${product.name}" ${product.unit === "kg" ? "por kg" : "por unidad"} en Patagonia: hay que corregir el vínculo. No se agregó.` };
  }
  if (!weighed && !Number.isInteger(scan.quantity)) return { ok: false, reason: `${label}: la cantidad ${scan.quantity} no es un número entero de unidades. No se agregó.` };
  const prices = scan.item.prices.filter((p) => p > 0);
  if (prices.length === 0) return { ok: false, reason: `${label} no tiene precio en la balanza. No se agregó.` };
  const item: PaperItem = { barcode: scan.barcode, scaleCode: scan.code, kind: "product", productId: product.id, name: product.name, unit, quantity: scan.quantity, prices, amount: null };
  return { ok: true, paper: { items: [...paper.items, item] }, item };
}

/** Venta libre que la balanza no imprime con código (ej. genérico con código de 5 cifras): importe escrito del papel. */
export function addLibreFromPaper(paper: Paper, amount: number, description = "Venta libre de la balanza"): Paper {
  return { items: [...paper.items, { barcode: null, scaleCode: null, kind: "libre", productId: null, name: description, unit: "unit", quantity: 1, prices: [], amount }] };
}

/** Escribe el importe del papel de una venta libre ya escaneada. */
export function setLibreAmount(paper: Paper, index: number, amount: number): Paper {
  return { items: paper.items.map((it, i) => (i === index && it.kind === "libre" ? { ...it, amount } : it)) };
}

export type CloseResult =
  | { ok: true; amounts: number[]; method: "listas" | "papel"; detail: string }
  /**
   * Hay 2 o más artículos IGUALES (mismo producto y cantidad) y las listas los explican a todos con el mismo precio.
   * Puede ser cierto, o precios a mano que suman lo mismo. Real (08/10, ticket 2300): dos cajones a $74.000 + $70.000
   * se deducían como $72.000 + $72.000. La persona confirma mirando el papel (acceptSplit) o escribe los importes.
   */
  | { ok: false; need: "confirm_split"; amounts: number[]; question: string; reason: string }
  | { ok: false; need: "libre_amounts"; indexes: number[]; reason: string }
  | { ok: false; need: "paper_amounts"; reason: string }
  | { ok: false; need: "fix"; reason: string };

const MAX_COMBOS = 4096;

/** Importe de cada artículo con listas de precios: solo si UNA combinación da exacto (±$1 de redondeo). */
export function settleWithPrices(quantities: number[], prices: number[][], target: number): number[] | "ninguna" | "varias" {
  const options = quantities.map((q, i) => [...new Set(prices[i].map((p) => Math.round(q * p)))]);
  if (options.reduce((n, o) => n * o.length, 1) > MAX_COMBOS) return "varias";
  const found = new Set<string>();
  const walk = (i: number, acc: number[], sum: number) => {
    if (found.size > 1) return;
    if (i === options.length) {
      if (Math.abs(sum - target) <= 1) found.add(acc.join(","));
      return;
    }
    for (const v of options[i]) walk(i + 1, [...acc, v], sum + v);
  };
  walk(0, [], 0);
  if (found.size === 0) return "ninguna";
  if (found.size > 1) return "varias";
  const amounts = [...found][0].split(",").map(Number);
  amounts[amounts.length - 1] += Math.round(target) - amounts.reduce((a, b) => a + b, 0);
  return amounts;
}

/**
 * Cierra el papel con el TOTAL. `paperAmounts`: importes de los PRODUCTOS (no de las ventas libres) copiados del papel,
 * en el orden del papel, cuando las listas no alcanzan.
 */
export function closePaper(paper: Paper, total: { amount: number; articles: number | null }, paperAmounts?: number[], opts: { acceptSplit?: boolean } = {}): CloseResult {
  const items = paper.items;
  if (items.length === 0) return { ok: false, need: "fix", reason: "no hay productos de este ticket escaneados antes del TOTAL" };
  if (total.articles !== null && total.articles !== items.length) {
    const diff = total.articles - items.length;
    return {
      ok: false,
      need: "fix",
      reason: diff > 0
        ? `el ticket tiene ${total.articles} artículos y se escanearon ${items.length}: falta escanear ${diff} (si es una venta libre sin código, agregala con su importe)`
        : `el ticket tiene ${total.articles} artículos y se escanearon ${items.length}: sobra ${-diff} (¿es de otro ticket o se escaneó dos veces?)`
    };
  }
  const libreMissing = items.map((it, i) => (it.kind === "libre" && !(it.amount && it.amount > 0) ? i : -1)).filter((i) => i >= 0);
  if (libreMissing.length > 0) return { ok: false, need: "libre_amounts", indexes: libreMissing, reason: "falta el importe de la venta libre (está en el papel)" };

  const target = Math.round(total.amount);
  const libreSum = items.reduce((s, it) => s + (it.kind === "libre" ? Math.round(it.amount ?? 0) : 0), 0);
  const productIdx = items.map((it, i) => (it.kind === "product" ? i : -1)).filter((i) => i >= 0);
  const productTarget = target - libreSum;
  if (productTarget < 0 || (productIdx.length > 0 && productTarget === 0)) return { ok: false, need: "fix", reason: "las ventas libres suman más que el TOTAL del ticket" };
  if (productIdx.length === 0 && productTarget !== 0) return { ok: false, need: "fix", reason: `las ventas libres suman $${libreSum} y el TOTAL es $${target}` };

  const result = items.map((it) => Math.round(it.amount ?? 0));
  if (paperAmounts) {
    if (paperAmounts.length !== productIdx.length || paperAmounts.some((a) => !(a > 0))) return { ok: false, need: "paper_amounts", reason: "falta el importe de algún artículo" };
    const sum = paperAmounts.reduce((a, b) => a + Math.round(b), 0);
    if (sum !== productTarget) return { ok: false, need: "paper_amounts", reason: `los importes escritos suman $${sum + libreSum} y el TOTAL del ticket es $${target}` };
    productIdx.forEach((idx, k) => (result[idx] = Math.round(paperAmounts[k])));
    return { ok: true, amounts: result, method: "papel", detail: "importes copiados del ticket impreso" };
  }
  if (productIdx.length > 0) {
    const s = settleWithPrices(productIdx.map((i) => items[i].quantity), productIdx.map((i) => items[i].prices), productTarget);
    if (s === "ninguna") return { ok: false, need: "paper_amounts", reason: "el total no coincide con los precios de lista de la balanza (precio a mano o cambiado)" };
    if (s === "varias") return { ok: false, need: "paper_amounts", reason: "más de una combinación de precios da el total" };
    productIdx.forEach((idx, k) => (result[idx] = s[k]));
    const groups = new Map<string, number[]>();
    for (const idx of productIdx) {
      const key = `${items[idx].productId}|${items[idx].quantity}`;
      groups.set(key, [...(groups.get(key) ?? []), idx]);
    }
    const repeated = [...groups.values()].filter((g) => g.length > 1);
    if (repeated.length > 0 && !opts.acceptSplit) {
      const question = repeated.map((g) => `${g.length} × ${describeItem(items[g[0]])}: $${result[g[0]].toLocaleString("es-AR")} cada uno`).join("; ");
      return { ok: false, need: "confirm_split", amounts: result, question, reason: "hay artículos iguales: hay que confirmar con el papel el importe de cada uno" };
    }
  }
  return { ok: true, amounts: result, method: "listas", detail: productIdx.length ? "importe de cada artículo según el precio de lista que usó la balanza" : "venta libre" };
}

/**
 * Huella del papel: el mismo papel escaneado dos veces da la misma huella. Dos papeles distintos con exactamente lo
 * mismo (dos clientes que llevan lo mismo) también: por eso una huella repetida se CONFIRMA, no se bloquea.
 */
export function paperFingerprint(totalBarcode: string, paper: Paper): string {
  const items = paper.items.map((it) => it.barcode ?? `libre:${Math.round(it.amount ?? 0)}`).sort();
  return `${totalBarcode}|${items.join(",")}`;
}

export function describeItem(it: PaperItem): string {
  return `${it.name} ${qtyText(it.quantity, it.unit)}`;
}
