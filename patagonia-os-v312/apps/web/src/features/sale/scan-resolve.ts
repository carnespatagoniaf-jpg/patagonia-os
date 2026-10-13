import type { Product } from "@patagonia/domain";
import { parseAuraSumTicket, parseSystelSumTicket, parseTicketTotalBarcode, parseWeightBarcode, type ScaleConfig } from "./scale-barcode";

/**
 * Qué hacer con un código escaneado (o tipeado + Enter) en Mostrador. Lógica pura, testeada
 * (scan-resolve.test.ts), sin estado ni pantallas: el hook decide los avisos de confirmación.
 *
 * Orden:
 * 1. Código idéntico al de un producto: ese producto (gana sobre cualquier lectura de balanza).
 * 2. Ticket de TOTAL de balanza (Kretz Aura, Systel "22…", Kretz "0000…"): una línea de plata,
 *    sin producto ni stock (el código no dice qué productos son).
 * 3. Etiqueta de balanza (formato de la sucursal): producto por su N.º de PLU + kilos o unidades.
 *    Solo si el código tiene forma de etiqueta: empieza con 2 (rango de códigos "de comercio"
 *    20-29 que usan las balanzas) y, con 13 dígitos, el dígito verificador EAN-13 es correcto.
 *    Si es una etiqueta pero el producto no existe, no tiene precio o la cantidad no tiene
 *    sentido, se devuelve un error y NO se agrega nada (el stock no se toca).
 * 4. Si no es nada de eso: se busca por nombre/código en la lista (lo resuelve el hook).
 */

export type ScanResolution =
  | { type: "product"; product: Product }
  | { type: "label"; product: Product; quantity: number; plu: string; detail: string }
  | { type: "ticket_total"; amount: number; key: string }
  | { type: "ticket_without_amount" }
  | { type: "error"; message: string }
  | { type: "search" };

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function validEan13(code: string): boolean {
  if (!/^[0-9]{13}$/.test(code)) return false;
  const d = code.split("").map(Number);
  const sum = d.slice(0, 12).reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === d[12];
}

/** ¿Tiene forma de etiqueta de balanza para este formato? (no dice todavía de qué producto). */
export function looksLikeScaleLabel(code: string, config: ScaleConfig): boolean {
  if (!/^[0-9]+$/.test(code) || code.length !== config.totalLength) return false;
  if (config.prefixLength > 0 && code[0] !== "2") return false;
  if (code.length === 13 && !validEan13(code)) return false;
  return true;
}

const fmtQty = (q: number, unit: string) => (unit === "kg" ? `${q.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg` : `${q} u.`);

export function resolveScan(rawInput: string, products: Product[], config: ScaleConfig): ScanResolution {
  const raw = rawInput.trim();
  if (!raw) return { type: "search" };
  const active = products.filter((p) => p.active ?? true);

  // 1. Código exacto de un producto.
  const exact = active.find((p) => p.code === raw);
  if (exact) return { type: "product", product: exact };

  // 2. Ticket de total.
  const aura = parseAuraSumTicket(raw);
  if (aura && aura.amount === null) return { type: "ticket_without_amount" };
  const label = looksLikeScaleLabel(raw, config) ? parseWeightBarcode(raw, config) : null;
  const labelProduct = label ? active.find((p) => p.code === label.plu) : undefined;
  const systel = labelProduct ? null : parseSystelSumTicket(raw);
  const total = aura?.amount ?? systel ?? parseTicketTotalBarcode(raw);
  if (total !== null) return { type: "ticket_total", amount: total, key: `ticket-${raw.padStart(13, "0")}` };

  // 3. Etiqueta de balanza.
  if (label) {
    if (!labelProduct) {
      const inactive = products.find((p) => p.code === label.plu);
      return {
        type: "error",
        message: inactive
          ? `La etiqueta es del producto N.º ${label.plu} (${inactive.name}), que está desactivado en Patagonia. No se agregó nada.`
          : `La etiqueta de la balanza es del producto N.º ${label.plu}, y en Patagonia no hay ningún producto con ese código. No se agregó nada: revisá que el número del producto en la balanza sea el mismo código que en Patagonia.`
      };
    }
    const p = labelProduct;
    if (!(p.priceRetail > 0)) {
      return { type: "error", message: `${p.name} no tiene precio cargado en Patagonia, así que se cobraría $0. No se agregó nada: cargale el precio en Stock y volvé a escanear.` };
    }
    let quantity: number;
    if (label.kind === "weight") {
      quantity = label.weightKg;
    } else {
      // La balanza grabó el importe: la cantidad sale del precio de Patagonia (al gramo).
      quantity = p.unit === "kg" ? round3(label.amount / p.priceRetail) : label.amount / p.priceRetail;
    }
    if (p.unit !== "kg") {
      // Por unidad: tiene que dar un número entero de unidades. Si no, el formato no se entendió.
      const units = Math.round(quantity);
      if (units < 1 || Math.abs(quantity - units) > 0.005) {
        return {
          type: "error",
          message: `${p.name} se vende por unidad, pero la etiqueta trae ${quantity.toLocaleString("es-AR", { maximumFractionDigits: 3 })}: no se pudo saber cuántas unidades son. No se agregó nada; cargalo a mano y avisá a soporte con una foto de la etiqueta.`
        };
      }
      quantity = units;
    } else {
      quantity = round3(quantity);
    }
    if (!(quantity > 0)) {
      return { type: "error", message: `La etiqueta de ${p.name} trae cantidad 0. No se agregó nada.` };
    }
    return { type: "label", product: p, quantity, plu: label.plu, detail: `${p.name}: ${fmtQty(quantity, p.unit)} (etiqueta de balanza)` };
  }

  // 4. Código exacto sin distinguir mayúsculas, o búsqueda.
  const loose = active.find((p) => p.code.toLowerCase() === raw.toLowerCase());
  if (loose) return { type: "product", product: loose };
  return { type: "search" };
}
