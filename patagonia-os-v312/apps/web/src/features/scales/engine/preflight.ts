import type { EngineProduct, ProductProblem } from "./types";

/**
 * Revisión ANTES de mandar productos a una balanza, igual para todas las marcas (etapa 1, 28/10).
 *
 * Regla: lo que llega a la balanza es exactamente lo que está en Patagonia, o no se manda. Nunca se redondea un precio,
 * nunca se corta un código, y nunca se manda un producto cuyo código la etiqueta no puede llevar (Mostrador leería otro
 * producto). El nombre sí se acorta (la balanza tiene pocas letras), pero se avisa cómo va a quedar.
 *
 * Los límites de cada modelo salen de `models.ts`; este archivo no sabe de marcas.
 */

export interface ModelLimits {
  /** Código más alto que guarda la balanza como número de producto. */
  maxCode: number;
  /** Código más alto que entra en la ETIQUETA (cifras del producto en el código de barras), o null si no se sabe todavía. */
  labelMaxCode: number | null;
  /** 0 = la balanza guarda pesos enteros; 2 = guarda centavos. */
  priceDecimals: 0 | 2;
  /** Número más alto que entra en el campo precio (ya con los decimales). */
  maxPriceRaw: number;
  /** Letras del nombre que muestra e imprime la balanza. */
  nameLength: number;
}

export interface PreflightResult {
  /** Productos que se pueden mandar exactos. */
  ready: EngineProduct[];
  /** No se mandan, con el motivo en palabras simples. */
  problems: ProductProblem[];
  /** Se mandan, pero conviene saberlo (por ejemplo, el nombre se acorta). */
  warnings: ProductProblem[];
}

const UNITS = new Set(["kg", "unit", "box"]);

/** Cómo queda el nombre en la balanza: mayúsculas, sin acentos, cortado a `length` letras. */
export function scaleName(name: string, length: number): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .toUpperCase()
    .trim()
    .slice(0, length)
    .trimEnd();
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("es-AR", { maximumFractionDigits: 2 })}`;
}

/**
 * ¿Ese código, en una etiqueta de `digits` cifras, se lee como el TOTAL de un ticket (código suma 99998 de las Kretz)?
 * Mostrador lo prueba antes que el producto (parseAuraSumTicket): 3 cifras → 998 y 999, 4 → 9998 y 9999, 5 → 99998.
 * Auditoría 29/10/2026: un producto con ese número se cobraba sin bajar stock.
 */
export function isTicketTotalCode(n: number, digits: number): boolean {
  const field = String(n).padStart(digits, "0");
  return field.length >= 3 && ("999998".endsWith(field) || "99998".startsWith(field));
}

/** Por qué un producto no se puede mandar exacto, o null si se puede. */
export function productProblem(p: EngineProduct, limits: ModelLimits): string | null {
  const code = p.code.trim();
  if (!/^\d+$/.test(code)) return "el código no es un número: en la balanza cada producto es un número";
  const n = Number(code);
  if (n < 1) return "el código es 0: la balanza no tiene producto 0";
  if (n > limits.maxCode) {
    return code.length >= 8
      ? "es un código de barras de fábrica: se vende escaneando su propio código, no va a la balanza"
      : `el código ${n} es más largo de lo que guarda la balanza (hasta ${limits.maxCode})`;
  }
  if (limits.labelMaxCode !== null && n > limits.labelMaxCode) {
    const digits = String(limits.labelMaxCode).length;
    return `el código ${n} tiene más de ${digits} cifras y la etiqueta lleva ${digits}: Mostrador leería otro producto. Poné un código de 1 a ${limits.labelMaxCode} en Stock`;
  }
  if (limits.labelMaxCode !== null && isTicketTotalCode(n, String(limits.labelMaxCode).length)) {
    return `el código ${n} es el que la balanza usa para el TOTAL del ticket: Mostrador cobraría el importe sin el producto ni el stock. Cambialo por otro código en Stock`;
  }
  if (!scaleName(p.name, limits.nameLength)) return "no tiene nombre: ponele uno en Stock";
  if (!UNITS.has(p.unit)) return "no dice si se vende por kilo o por unidad";
  const price = p.priceRetail;
  if (!Number.isFinite(price) || price <= 0) return "no tiene precio de venta: cargalo en Stock";
  const cents = Math.round(price * 100);
  if (Math.abs(price * 100 - cents) > 1e-6) return `el precio ${price} tiene más de 2 decimales`;
  if (limits.priceDecimals === 0 && cents % 100 !== 0) return `el precio ${fmtMoney(price)} tiene centavos y la balanza guarda pesos enteros: redondealo en Stock`;
  const raw = limits.priceDecimals === 2 ? cents : cents / 100;
  if (raw > limits.maxPriceRaw) {
    const max = limits.priceDecimals === 2 ? limits.maxPriceRaw / 100 : limits.maxPriceRaw;
    return `el precio ${fmtMoney(price)} es más alto de lo que entra en la balanza (${fmtMoney(max)})`;
  }
  return null;
}

/** Revisa todos los productos activos. Los códigos repetidos se sacan los dos (nunca se pisa uno con otro). */
export function preflightProducts(products: EngineProduct[], limits: ModelLimits): PreflightResult {
  const active = products.filter((p) => p.active ?? true);
  const problems: ProductProblem[] = [];
  const warnings: ProductProblem[] = [];
  const candidates: EngineProduct[] = [];
  for (const p of active) {
    const why = productProblem(p, limits);
    if (why) problems.push({ code: p.code, name: p.name, reason: why });
    else candidates.push(p);
  }
  const byCode = new Map<number, EngineProduct[]>();
  for (const p of candidates) byCode.set(Number(p.code), [...(byCode.get(Number(p.code)) ?? []), p]);
  const ready: EngineProduct[] = [];
  for (const [code, group] of byCode) {
    if (group.length > 1) {
      for (const p of group) problems.push({ code: p.code, name: p.name, reason: `hay ${group.length} productos con el código ${code}: cambiale el código a uno en Stock` });
      continue;
    }
    const p = group[0];
    ready.push(p);
    const shown = scaleName(p.name, limits.nameLength);
    if (shown !== scaleName(p.name, 200)) warnings.push({ code: p.code, name: p.name, reason: `en la balanza el nombre queda "${shown}"` });
  }
  ready.sort((a, b) => Number(a.code) - Number(b.code));
  return { ready, problems, warnings };
}

/** Código más alto que entra en una etiqueta según el formato de la balanza ("20PPPPCCCCCC" → 9999), o null. */
export function labelMaxCodeFromFormat(format: string | null | undefined): number | null {
  const m = /P+/.exec(format ?? "");
  return m ? Math.pow(10, m[0].length) - 1 : null;
}
