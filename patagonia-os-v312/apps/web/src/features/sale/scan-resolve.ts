import type { Product } from "@patagonia/domain";
import { parseAuraSumTicket, parseSumTicketWithConfig, parseSystelSumTicket, parseTicketTotalBarcode, parseWeightBarcode, systelSumWithoutAmount, type ScaleConfig } from "./scale-barcode";

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

/** Lo más que pesa una balanza de mostrador (Kretz Report/Aura, Systel Cuora: 30-31 kg). */
export const MAX_COUNTER_SCALE_KG = 31;

/**
 * ¿Tiene sentido el peso de una etiqueta? Un producto por kg con más de MAX_COUNTER_SCALE_KG casi seguro es un
 * formato de etiqueta mal leído (real El Dorado 29/10: $99.934 leído como 99,934 kg): "excesivo" se pregunta.
 * Cero, negativo o no numérico: "invalido", no se agrega.
 */
export function labelWeightProblem(unit: string, quantity: number): "invalido" | "excesivo" | null {
  if (!Number.isFinite(quantity) || quantity <= 0) return "invalido";
  if (unit === "kg" && quantity > MAX_COUNTER_SCALE_KG) return "excesivo";
  return null;
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

/**
 * Etiqueta Kretz con peso: "20"/"21" + producto (5) + gramos (5) + verificador (real Lauda 18/11/2026, Report NX2:
 * 2100037017403 = PLU 37, 1,740 kg). Ese formato lo trae la etiqueta de la balanza aunque la sucursal tenga guardado
 * otro (la 2-3-7 con importe que Patagonia les configura con 1070), así que se prueba SOLO cuando el formato de la
 * sucursal no encontró producto, y solo si da un producto por kilo que existe con un peso de balanza de mostrador.
 */
export const KRETZ_PLU5_WEIGHT_CONFIG: ScaleConfig = { prefixLength: 2, pluLength: 5, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" };

function isKretzPlu5Weight(config: ScaleConfig): boolean {
  return config.prefixLength === 2 && config.pluLength === 5 && config.weightLength === 5 && config.totalLength === 13 && config.payloadType === "weight";
}

/**
 * Etiqueta Kretz 2-5-5: "21" = gramos, "20" = IMPORTE en pesos enteros (real Oliem 18/11/2026: una Report por red con
 * "21" + peso y otra balanza en el mismo local con "20" + importe; 2000212051836 = PLU 212, $5.183, que se leía como
 * 5,183 kg y cobraba 3,3 veces de más).
 */
function kretzPlu5Label(raw: string): { plu: string; kind: "weight"; weightKg: number } | { plu: string; kind: "amount"; amount: number } | null {
  if (!/^2[01]\d{11}$/.test(raw) || !validEan13(raw)) return null;
  const plu = String(parseInt(raw.slice(2, 7), 10));
  const value = parseInt(raw.slice(7, 12), 10);
  if (!(value > 0)) return null;
  return raw.startsWith("20") ? { plu, kind: "amount", amount: value } : { plu, kind: "weight", weightKg: value / 1000 };
}

export function kretzWeightLabel(raw: string, config: ScaleConfig, active: Product[]): { label: NonNullable<ReturnType<typeof kretzPlu5Label>>; product: Product } | null {
  if (isKretzPlu5Weight(config)) return null;
  const parsed = kretzPlu5Label(raw);
  if (!parsed || (parsed.kind === "weight" && parsed.weightKg > MAX_COUNTER_SCALE_KG)) return null;
  const product = findByPlu(active, parsed.plu, "kg");
  return product && product.unit === "kg" ? { label: parsed, product } : null;
}

/** El formato 2-3-7 con importe en centavos que Patagonia les configura a las Kretz (1070 "2002005" / "2112005"). */
export function isKretz237Amount(config: ScaleConfig): boolean {
  return config.prefixLength === 2 && config.pluLength === 3 && config.weightLength === 7 && config.weightDivisor === 100 && config.totalLength === 13 && config.payloadType === "amount";
}

/**
 * Report con 1070 "2112005": los productos por kilo salen "21" + producto (3) + gramos (7) + verificador. Solo con el
 * formato 2-3-7 de la sucursal, EAN válido, producto por kilo que existe y peso de balanza de mostrador.
 */
export function kretz237WeightLabel(raw: string, config: ScaleConfig, active: Product[]): { label: { plu: string; kind: "weight"; weightKg: number }; product: Product } | null {
  if (!isKretz237Amount(config) || !/^21\d{11}$/.test(raw) || !validEan13(raw)) return null;
  const plu = String(parseInt(raw.slice(2, 5), 10));
  const weightKg = parseInt(raw.slice(5, 12), 10) / 1000;
  if (!(weightKg > 0) || weightKg > MAX_COUNTER_SCALE_KG) return null;
  const product = findByPlu(active, plu, "kg");
  return product && product.unit === "kg" ? { label: { plu, kind: "weight", weightKg }, product } : null;
}

/**
 * El producto de un N.º de balanza: el código igual; si no hay, el único código de solo números con el mismo valor
 * ("0037" = 37: Patagonia graba en la balanza Number(código), así que los ceros de adelante se pierden en la etiqueta).
 */
export function findByPlu(products: Product[], plu: string, unit?: "kg"): Product | undefined {
  const candidates = pluCandidates(products, plu);
  if (candidates.length === 1) return candidates[0];
  // Dos productos con el mismo número (REAL El corte argentino 24/11/2026: "1" Pepas por unidad y "01" AGUJA por kg).
  // Una etiqueta con PESO solo puede ser del que se vende por kilo: si hay uno solo así, es ese.
  if (unit === "kg") {
    const kg = candidates.filter((p) => p.unit === "kg");
    if (kg.length === 1) return kg[0];
  }
  return candidates.find((p) => p.code === plu);
}

/** Todos los productos que la balanza puede estar nombrando con ese N.º ("1" y "01" son el mismo para la balanza). */
export function pluCandidates(products: Product[], plu: string): Product[] {
  const n = Number(plu);
  return products.filter((p) => p.code === plu || (/^\d+$/.test(p.code) && Number(p.code) === n));
}

/** Texto para el cajero cuando dos o más productos de Patagonia tienen el mismo N.º de balanza, o null. */
export function duplicatePluNote(products: Product[], plu: string): string | null {
  const c = pluCandidates(products, plu);
  if (c.length < 2) return null;
  return `En Patagonia hay ${c.length} productos con el número ${plu}: ${c.map((p) => `${p.name} (código "${p.code}", ${p.unit === "kg" ? "por kg" : "por unidad"})`).join(" y ")}. Para la balanza "1" y "01" son el mismo número: cambiale el código a uno de ellos en Stock (Editar).`;
}

/**
 * Etiqueta por kilo cuyo código trae el importe en PESOS ENTEROS: el papel trae los centavos (kilos × precio) y el
 * código no. REAL El Abastero 24/11/2026, Report LT: "CUADRIL 0,125 kg × $18.333 = $2.291,63", código $2.291. Se cobra
 * kilos (al gramo) × precio, solo si da el mismo peso entero que el código (si el precio de la balanza es otro, se
 * cobra el del código). Cuentas en enteros (gramos × precio) para no perder el medio centavo.
 */
export function pesosLabelWithCents(amount: number, kg: number, price: number): number {
  const cents = Math.round((Math.round(kg * 1000) * Math.round(price * 100)) / 1000);
  const exact = cents / 100;
  return Math.abs(exact - amount) < 1 ? exact : amount;
}

const fmtQty =(q: number, unit: string) => (unit === "kg" ? `${q.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg` : `${q} u.`);

/** Formato de la Aura con inicio "22": producto (3) + importe en centavos (7); producto 998 = TOTAL del ticket. */
export const AURA_22_CONFIG: ScaleConfig = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" };

function resolveAura22(raw: string, products: Product[]): ScanResolution {
  // TOTAL del ticket (código suma 998). Va primero: con inicio "22" el lector de Systel lo tomaría como su TOTAL.
  if (raw.slice(2, 5) === "998") {
    const value = raw.slice(5, 12);
    if (/^(0+|9+)$/.test(value)) {
      return { type: "ticket_without_amount", message: "Este ticket de la Aura no trae el importe en el código de barras (pasa de $99.999,99). Cargá el TOTAL impreso con \"Vender algo sin código\"." };
    }
    return { type: "ticket_total", amount: parseInt(value, 10) / 100, key: `ticket-${raw}` };
  }
  const r = resolveScan(raw, products, AURA_22_CONFIG);
  if (r.type === "systel_total" || r.type === "search") {
    const plu = String(parseInt(raw.slice(2, 5), 10));
    return { type: "error", message: `La etiqueta de la Aura es del producto N.º ${plu}, y en Patagonia no hay ningún producto con ese código. No se agregó nada.` };
  }
  return r;
}

export function resolveScan(rawInput: string, products: Product[], config: ScaleConfig): ScanResolution {
  const raw = rawInput.trim();
  if (!raw) return { type: "search" };
  const active = products.filter((p) => p.active ?? true);

  // 1. Código exacto de un producto.
  const exact = active.find((p) => p.code === raw);
  if (exact) return { type: "product", product: exact };

  // Aura con inicio "22" en un local que tiene además otra balanza (AURA_PREFIX_22_BRANCHES, El Abastero 25/11/2026).
  if (config.auraPrefix22 && /^22\d{11}$/.test(raw) && validEan13(raw)) return resolveAura22(raw, products);

  // 2. Ticket de total.
  // El formato guardado de la sucursal manda sobre los de fábrica (El Abastero: 1-6-5 en pesos, no 2-5-5 en centavos).
  const ownSum = parseSumTicketWithConfig(raw, config);
  const aura = ownSum ? { amount: ownSum.amount } : parseAuraSumTicket(raw);
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
  // Kretz Report con etiqueta por peso (1070 "2112005", Carplat 18/11/2026): con el 2-3-7 con importe de la sucursal,
  // "21" trae los GRAMOS (nunca un importe) y "20" sigue siendo importe (etiquetas viejas y productos por unidad).
  const weight237 = kretz237WeightLabel(raw, config, active);
  const is237Weight = weight237 !== null || (isKretz237Amount(config) && raw.startsWith("21"));
  const byConfig = !weight237 && !is237Weight && looksLikeScaleLabel(raw, config) && !(isKretzPlu5Weight(config) && /^2[01]/.test(raw));
  let label = weight237
    ? weight237.label
    : !is237Weight && looksLikeScaleLabel(raw, config)
      ? isKretzPlu5Weight(config) && /^2[01]/.test(raw)
        ? kretzPlu5Label(raw)
        : parseWeightBarcode(raw, config)
      : null;
  // Importe en PESOS ENTEROS del formato de la sucursal (divisor 1): el papel trae los centavos y el código no.
  let pesosAmount = byConfig && config.payloadType === "amount" && config.weightDivisor === 1;
  let labelProduct = weight237 ? weight237.product : label ? findByPlu(active, label.plu, label.kind === "weight" ? "kg" : undefined) : undefined;
  if (!labelProduct) {
    const alt = kretzWeightLabel(raw, config, active);
    if (alt) {
      label = alt.label;
      labelProduct = alt.product;
      pesosAmount = false;
    }
  }
  if (!labelProduct && is237Weight && /^21\d{11}$/.test(raw) && validEan13(raw)) {
    const plu = String(parseInt(raw.slice(2, 5), 10));
    const p = findByPlu(products, plu);
    return {
      type: "error",
      message: p
        ? `La etiqueta es de ${p.name} (N.º ${plu}) con ${(parseInt(raw.slice(5, 12), 10) / 1000).toLocaleString("es-AR", { maximumFractionDigits: 3 })} kg, pero ${(p.active ?? true) ? "ese producto no se vende por kilo o el peso no es de balanza de mostrador" : "está desactivado en Patagonia"}. No se agregó nada.`
        : `La etiqueta de la balanza es del producto N.º ${plu}, y en Patagonia no hay ningún producto con ese código. No se agregó nada.`
    };
  }
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
      const dup = duplicatePluNote(active, label.plu);
      if (dup) return { type: "error", message: `La etiqueta es del producto N.º ${label.plu} de la balanza. ${dup} No se agregó nada: mientras tanto, buscalo por nombre y cargá lo que dice el papel.` };
      const inactive = findByPlu(products, label.plu);
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
          message: label.kind === "weight"
            ? `La etiqueta trae ${quantity.toLocaleString("es-AR", { maximumFractionDigits: 3 })} kg del producto N.º ${label.plu}, pero en Patagonia el N.º ${label.plu} es ${p.name}, que se vende por unidad. ${duplicatePluNote(active, label.plu) ?? `Revisá en Stock que el código de ${p.name} sea el mismo número que tiene ese producto en la balanza, o que ${p.name} esté "por kg".`} No se agregó nada: mientras tanto, buscalo por nombre y cargá los kilos del papel.`
            : `${p.name} se vende por unidad, pero la etiqueta trae ${quantity.toLocaleString("es-AR", { maximumFractionDigits: 3 })}: no se pudo saber cuántas unidades son. No se agregó nada; cargalo a mano y avisá a soporte con una foto de la etiqueta.`
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
    const amount = label.kind === "amount" ? (pesosAmount && p.unit === "kg" ? pesosLabelWithCents(label.amount, quantity, p.priceRetail) : label.amount) : undefined;
    return { type: "label", product: p, quantity, plu: label.plu, detail: `${p.name}: ${fmtQty(quantity, p.unit)} (etiqueta de balanza)`, ...(amount !== undefined ? { amount } : {}) };
  }

  // 4. Código exacto sin distinguir mayúsculas, o búsqueda.
  const loose = active.find((p) => p.code.toLowerCase() === raw.toLowerCase());
  if (loose) return { type: "product", product: loose };
  return { type: "search" };
}
