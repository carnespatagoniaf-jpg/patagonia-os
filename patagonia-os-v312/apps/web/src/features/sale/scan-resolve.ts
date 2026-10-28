import type { Product } from "@patagonia/domain";
import { parseAuraSumTicket, parseSystelSumTicket, parseTicketTotalBarcode, parseWeightBarcode, systelSumWithoutAmount, type ScaleConfig } from "./scale-barcode";

/**
 * Qué hacer con un código escaneado (o tipeado + Enter) en Mostrador. Lógica pura, testeada
 * (scan-resolve.test.ts), sin estado ni pantallas: el hook decide los avisos de confirmación.
 *
 * Orden:
 * 1. Código idéntico al de un producto: ese producto (gana sobre cualquier lectura de balanza).
 * 2. Ticket de TOTAL de balanza (Kretz Aura, Kretz "0000…"): una línea de plata, sin producto
 *    ni stock (el código no dice qué productos son). El TOTAL de una Systel ("22…") NO se carga:
 *    trae solo el importe y la cantidad de artículos ("22AAIIIIIIII"), y se cobra escaneando el
 *    código de cada artículo (real Los gringos 13/10: $73.118 = cajón + trozadito; convertir el
 *    total en kilos de un producto daba "TROZADITO 14,061 kg").
 * 3. Etiqueta de balanza (formato de la sucursal): producto por su N.º de PLU + kilos o unidades.
 *    Solo si el código tiene forma de etiqueta: empieza con 2 (rango de códigos "de comercio"
 *    20-29 que usan las balanzas) y, con 13 dígitos, el dígito verificador EAN-13 es correcto.
 *    Si es una etiqueta pero el producto no existe, no tiene precio o la cantidad no tiene
 *    sentido, se devuelve un error y NO se agrega nada (el stock no se toca).
 * 4. Si no es nada de eso: se busca por nombre/código en la lista (lo resuelve el hook).
 */

export type ScanResolution =
  | { type: "product"; product: Product }
  | { type: "label"; product: Product; quantity: number; plu: string; detail: string; /** Importe impreso por la balanza (etiquetas con importe): se cobra ESE, no cantidad × precio. */ amount?: number }
  | { type: "ticket_total"; amount: number; key: string }
  | { type: "ticket_without_amount"; message: string }
  /** TOTAL de una Systel: el detalle se lee de la balanza por cable (si está conectada); si no, `message`. */
  | { type: "systel_total"; amount: number; key: string; message: string }
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

/** Etiqueta con importe de un producto que existe, pero con el importe en 0 o todo en 9: mensaje de error, o null. */
export function amountOverflow(raw: string, config: ScaleConfig, active: Product[]): string | null {
  if (config.payloadType !== "amount" || !looksLikeScaleLabel(raw, config)) return null;
  const start = config.prefixLength + config.pluLength;
  const value = raw.slice(start, start + config.weightLength);
  if (!/^(0+|9+)$/.test(value)) return null;
  const plu = String(parseInt(raw.slice(config.prefixLength, start), 10));
  const product = active.find((p) => p.code === plu);
  if (!product) return null;
  const max = (Math.pow(10, config.weightLength) - 1) / config.weightDivisor;
  return `La etiqueta de ${product.name} no trae el importe en el código de barras: pasa de ${max.toLocaleString("es-AR", { minimumFractionDigits: 2 })}, lo más alto que entra. No se agregó nada. Cobralo con "Vender algo sin código" por el importe impreso, o pesalo en dos partes.`;
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
  if (aura && aura.amount === null) {
    return {
      type: "ticket_without_amount",
      message: "Este ticket de la balanza no trae el importe en el código de barras (con el formato actual de la balanza solo entran tickets de hasta $999,99). Cargá el TOTAL impreso con \"Vender algo sin código\" y avisale al encargado: en Productos → \"Balanza por cable\" → \"Mandar productos a la balanza\", Patagonia le ajusta el código de barras a la balanza."
    };
  }
  // Etiqueta con importe que no entró en el campo (7 cifras en centavos = hasta $99.999,99): la balanza pone todo
  // en 0 (REAL Aura con 2-5-5) o todo en 9 (REAL Systel). Nunca se cobra: el importe impreso no está en el código.
  const overflow = amountOverflow(raw, config, active);
  if (overflow) return { type: "error", message: overflow };
  const label = looksLikeScaleLabel(raw, config) ? parseWeightBarcode(raw, config) : null;
  const labelProduct = label ? active.find((p) => p.code === label.plu) : undefined;
  if (!labelProduct && systelSumWithoutAmount(raw)) {
    return {
      type: "ticket_without_amount",
      message: "Ese es el código del TOTAL del ticket, y en esta balanza no trae el importe. Escaneá el código de cada producto (el que está debajo de cada uno): así se cargan los productos con sus kilos y se descuenta el stock. No se agregó nada."
    };
  }
  const systel = labelProduct ? null : parseSystelSumTicket(raw);
  if (systel !== null) {
    return {
      type: "systel_total",
      amount: systel,
      key: `ticket-${raw}`,
      message: `Ese es el código del TOTAL del ticket ($${systel.toLocaleString("es-AR")}): no dice qué productos son ni cuántos kilos, así que no se cargó. Escaneá el código que está debajo de CADA producto del ticket. Si debajo de un producto el código sale en ceros (0 000000 000000), buscá ese producto y escribí los kilos o unidades que dice el ticket.`
    };
  }
  const total = aura?.amount ?? parseTicketTotalBarcode(raw);
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
    if (p.unit !== "kg" && label.kind === "weight" && config.prefixLength === 2 && raw.startsWith("21")) {
      // Systel venta por UNIDAD ("21PPPPCCCCCC", C = "cantidad (kg o unidades)" según el manual).
      // No hay todavía una etiqueta real por unidad: se aceptan las dos formas posibles, unidades
      // en milésimas (000002000 → 2, como los kilos) o enteras (000002 → 2). Otra cosa: error.
      const n = Math.round(label.weightKg * config.weightDivisor);
      quantity = n % 1000 === 0 ? n / 1000 : n < 1000 ? n : n / 1000;
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
    // Con importe: se cobra lo que cobró la balanza (real Pollo y mar 15/10: 0,245 kg × $15.900 = $3.895,50 y la Aura
    // imprime $3.895; recalcular daba $3.896).
    return { type: "label", product: p, quantity, plu: label.plu, detail: `${p.name}: ${fmtQty(quantity, p.unit)} (etiqueta de balanza)`, ...(label.kind === "amount" ? { amount: label.amount } : {}) };
  }

  // 4. Código exacto sin distinguir mayúsculas, o búsqueda.
  const loose = active.find((p) => p.code.toLowerCase() === raw.toLowerCase());
  if (loose) return { type: "product", product: loose };
  return { type: "search" };
}
