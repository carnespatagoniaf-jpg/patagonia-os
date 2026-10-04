import { toCuoraText } from "./systel-frame";

/**
 * Formatos de producto (PLU) de las Cuora, tal como los documenta Systel.
 * Cambian según el firmware, por eso hay 4:
 *
 * - "cuora2" (Cuora 2, protocolo V4.0, 2010): leer = función 3, escribir = función 4.
 *   PLU 4 dígitos, código 5, 2 precios, tara 6, letra N/M (N pone los totales de venta a 0).
 * - "max60" (Cuora Max, V6.0, 2016): leer = 62, escribir = 61. PLU 4, código 5, 2 precios.
 * - "max62" (Cuora Max, V6.2, 2021): igual que max60 pero PLU 6 y código 6.
 * - "max7"  (Cuora Max, V7.0, 2022): PLU 6, código 6, 5 precios con rango, porción y 10 datos nutricionales.
 *
 * Ninguno trae un número de versión confiable en la firma digital (todos dicen "0040"
 * en el documento), así que el formato se reconoce por el LARGO de la respuesta de
 * lectura (son todos distintos) y por los campos numéricos. Patagonia solo escribe
 * en el mismo formato que leyó en esa balanza.
 *
 * Lo que va después de la tara (agua, tabla nutricional, origen, lote, código de
 * barras, ingredientes…) Patagonia no lo usa: se guarda tal cual en `tail`.
 */

export type SystelLayout = "cuora2" | "max60" | "max62" | "max7";
export type SystelSaleType = "P" | "U" | "E" | "C";

export const LAYOUT_INFO: Record<SystelLayout, { label: string; readFn: number; writeFn: number; pluDigits: number; codeDigits: number; priceLists: number; tareDigits: number; tailFixed: number; maxPlu: number; maxCode: number }> = {
  cuora2: { label: "Cuora 2 (protocolo V4.0)", readFn: 3, writeFn: 4, pluDigits: 4, codeDigits: 5, priceLists: 2, tareDigits: 6, tailFixed: 1, maxPlu: 9999, maxCode: 99997 },
  max60: { label: "Cuora Max (protocolo V6.0)", readFn: 62, writeFn: 61, pluDigits: 4, codeDigits: 5, priceLists: 2, tareDigits: 4, tailFixed: 105, maxPlu: 9999, maxCode: 99997 },
  max62: { label: "Cuora Max (protocolo V6.2)", readFn: 62, writeFn: 61, pluDigits: 6, codeDigits: 6, priceLists: 2, tareDigits: 4, tailFixed: 105, maxPlu: 999999, maxCode: 999999 },
  max7: { label: "Cuora Max (protocolo V7.0)", readFn: 62, writeFn: 61, pluDigits: 6, codeDigits: 6, priceLists: 5, tareDigits: 4, tailFixed: 121, maxPlu: 999999, maxCode: 999999 }
};

export interface SystelPlu {
  layout: SystelLayout;
  number: number;
  /** cuora2: "versión"; max: "gestión" (0 balanza, 1 PC). Solo lectura. */
  managedBy: string;
  name: string;
  /** Precios crudos (6 números, sin coma). 2 en cuora2/max60/max62, 5 en max7. */
  prices: number[];
  /** Solo max7: rango de cada lista (gramos). */
  ranges: number[];
  code: number;
  sector: number;
  expiryDays: number;
  saleType: SystelSaleType;
  tareGrams: number;
  /** Todo lo que sigue a la tara, sin tocar. */
  tail: string;
  /** El texto leído completo (respaldo). */
  raw: string;
}

function digits(s: string): number | null {
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** Interpreta la respuesta de lectura de un PLU con un formato dado. null si no encaja. */
export function parsePluAs(layout: SystelLayout, data: string, expectedNumber?: number): SystelPlu | null {
  const info = LAYOUT_INFO[layout];
  let pos = 0;
  const take = (n: number) => {
    const s = data.slice(pos, pos + n);
    pos += n;
    return s;
  };
  const number = digits(take(info.pluDigits));
  const managedBy = take(1);
  const name = take(18);
  const prices: number[] = [];
  const ranges: number[] = [];
  for (let i = 0; i < info.priceLists; i++) {
    const p = digits(take(6));
    if (p === null) return null;
    prices.push(p);
    if (layout === "max7") {
      const r = digits(take(6));
      if (r === null) return null;
      ranges.push(r);
    }
  }
  const code = digits(take(info.codeDigits));
  const sector = digits(take(2));
  const expiryDays = digits(take(4));
  const saleType = take(1);
  const tareGrams = digits(take(info.tareDigits));
  const tail = data.slice(pos);
  if (number === null || code === null || sector === null || expiryDays === null || tareGrams === null) return null;
  if (!["P", "U", "E", "C"].includes(saleType)) return null;
  if (expectedNumber !== undefined && number !== expectedNumber) return null;
  const flag = tail[info.tailFixed - 1];
  const expectedTail = info.tailFixed + (flag === "S" ? 100 : 0);
  if (tail.length !== expectedTail || (flag !== "S" && flag !== "N")) return null;
  return { layout, number, managedBy, name, prices, ranges, code, sector, expiryDays, saleType: saleType as SystelSaleType, tareGrams, tail, raw: data };
}

/** Reconoce el formato por el largo y los campos. Devuelve todos los que encajan (lo normal es uno). */
export function detectPluLayouts(data: string, expectedNumber?: number, only?: SystelLayout[]): SystelPlu[] {
  const layouts = only ?? (Object.keys(LAYOUT_INFO) as SystelLayout[]);
  return layouts.map((l) => parsePluAs(l, data, expectedNumber)).filter((p): p is SystelPlu => p !== null);
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** Datos de la orden de lectura de un PLU (función 3 o 62). */
export function readPluRequest(layout: SystelLayout, number: number): string {
  return pad(number, LAYOUT_INFO[layout].pluDigits);
}

/** Lo que Patagonia manda para un producto NUEVO: lo demás va vacío / en cero. */
export interface NewPluInput {
  number: number;
  name: string;
  code: number;
  saleType: "P" | "U";
  /** Precio crudo de la lista 1 (ya convertido con los decimales de esa balanza). */
  priceRaw: number;
  sector?: number;
  expiryDays?: number;
  tareGrams?: number;
}

function defaultTail(layout: SystelLayout): string {
  const n4 = "0000";
  if (layout === "cuora2") return "N";
  const nutrition = layout === "max7" ? "N" + " ".repeat(30) + n4 + n4 + n4.repeat(10) : "N" + " ".repeat(30) + n4.repeat(8);
  // agua + tabla + origen + conservación + receta + lote + tipo EAN (0 = el general de la balanza) + configuración EAN + ingredientes N
  return n4 + nutrition + n4 + n4 + n4 + "0".repeat(12) + "0" + " ".repeat(12) + "N";
}

export function validateNewPlu(layout: SystelLayout, input: NewPluInput): string | null {
  const info = LAYOUT_INFO[layout];
  if (!Number.isInteger(input.number) || input.number < 1 || input.number > info.maxPlu) return `número de PLU fuera de rango (1 a ${info.maxPlu})`;
  if (!Number.isInteger(input.code) || input.code < 1 || input.code > info.maxCode) return `código fuera de rango (1 a ${info.maxCode})`;
  if (!Number.isInteger(input.priceRaw) || input.priceRaw < 0 || input.priceRaw > 999999) return "precio fuera de rango (6 números)";
  const tare = input.tareGrams ?? 0;
  if (!Number.isInteger(tare) || tare < 0 || tare > (info.tareDigits === 6 ? 999999 : 9999)) return "tara fuera de rango";
  const exp = input.expiryDays ?? 0;
  if (!Number.isInteger(exp) || exp < 0 || exp > 9999) return "vencimiento fuera de rango (0 a 9999 días)";
  const sector = input.sector ?? 1;
  if (!Number.isInteger(sector) || sector < 1 || sector > 99) return "sector fuera de rango (1 a 99)";
  if (input.saleType !== "P" && input.saleType !== "U") return "tipo de venta inválido (P por kilo, U por unidad)";
  return null;
}

/**
 * Datos de la orden de escritura de un PLU NUEVO (función 4 o 61).
 * cuora2: lleva la versión ("1", gestionado desde la PC; HIPÓTESIS) y "N" (producto nuevo, totales en 0).
 */
export function buildNewPluData(layout: SystelLayout, input: NewPluInput): string {
  const err = validateNewPlu(layout, input);
  if (err) throw new Error(err);
  const info = LAYOUT_INFO[layout];
  const name = toCuoraText(input.name, 18);
  const priceBlock =
    layout === "max7"
      ? pad(input.priceRaw, 6) + "000000" + "000000000000".repeat(4)
      : pad(input.priceRaw, 6) + "000000";
  const tare = input.saleType === "U" ? 0 : input.tareGrams ?? 0;
  const head = layout === "cuora2" ? pad(input.number, 4) + "1" : pad(input.number, info.pluDigits);
  const middle = `${name}${priceBlock}${pad(input.code, info.codeDigits)}${pad(input.sector ?? 1, 2)}${pad(input.expiryDays ?? 0, 4)}${input.saleType}${pad(tare, info.tareDigits)}`;
  return layout === "cuora2" ? `${head}${middle}N${defaultTail(layout)}` : `${head}${middle}${defaultTail(layout)}`;
}

/** Cómo debería releerse un producto nuevo (para compararlo campo por campo). `managedBy` no se compara. */
export function expectedReadOfNew(layout: SystelLayout, input: NewPluInput): Omit<SystelPlu, "managedBy" | "raw"> {
  const info = LAYOUT_INFO[layout];
  return {
    layout,
    number: input.number,
    name: toCuoraText(input.name, 18),
    prices: Array.from({ length: info.priceLists }, (_, i) => (i === 0 ? input.priceRaw : 0)),
    ranges: layout === "max7" ? [0, 0, 0, 0, 0] : [],
    code: input.code,
    sector: input.sector ?? 1,
    expiryDays: input.expiryDays ?? 0,
    saleType: input.saleType,
    tareGrams: input.saleType === "U" ? 0 : input.tareGrams ?? 0,
    tail: defaultTail(layout)
  };
}

/**
 * Cambio de precio (función 33): "La balanza cambia los precios manteniendo todos
 * los demás datos intactos. Se mantienen los totalizadores de ventas." (DOCUMENTADO).
 * Lleva las listas 1 y 2: la 2 se conserva tal como estaba.
 * "Versión del PLU (1 letra)" no tiene valores documentados: se manda "1"
 * (gestionado desde la PC, como en la lista de PLU). HIPÓTESIS hasta la prueba.
 */
export function buildPriceChangeData(current: SystelPlu, newPriceRaw: number): string {
  if (!Number.isInteger(newPriceRaw) || newPriceRaw < 0 || newPriceRaw > 999999) throw new Error("precio fuera de rango (6 números)");
  const info = LAYOUT_INFO[current.layout];
  return `${pad(current.number, info.pluDigits)}1${pad(newPriceRaw, 6)}${pad(current.prices[1] ?? 0, 6)}`;
}

export type PluField = "nombre" | "precios" | "rangos" | "codigo" | "sector" | "vencimiento" | "tipo" | "tara" | "resto";

/** Compara lo esperado con lo releído. Devuelve los campos distintos (vacío = idéntico). */
export function diffPlu(expected: Omit<SystelPlu, "managedBy" | "raw">, actual: SystelPlu): PluField[] {
  const out: PluField[] = [];
  if (expected.name !== actual.name) out.push("nombre");
  if (expected.prices.join(",") !== actual.prices.join(",")) out.push("precios");
  if (expected.ranges.join(",") !== actual.ranges.join(",")) out.push("rangos");
  if (expected.code !== actual.code) out.push("codigo");
  if (expected.sector !== actual.sector) out.push("sector");
  if (expected.expiryDays !== actual.expiryDays) out.push("vencimiento");
  if (expected.saleType !== actual.saleType) out.push("tipo");
  if (expected.tareGrams !== actual.tareGrams) out.push("tara");
  if (expected.tail !== actual.tail) out.push("resto");
  return out;
}

/** Lo que debería quedar después de un cambio de precio: todo igual menos la lista 1. */
export function expectedAfterPriceChange(current: SystelPlu, newPriceRaw: number): Omit<SystelPlu, "managedBy" | "raw"> {
  const { managedBy: _m, raw: _r, ...rest } = current;
  return { ...rest, prices: [newPriceRaw, ...current.prices.slice(1)] };
}

/** Lista de PLU (función 31): "N" + número (4 o 6) + "V" + versión, repetido, y "F" al final. */
export interface PluListEntry {
  number: number;
  /** 0 creado en la balanza, 1 gestionado desde la PC, 2 modificado en la balanza. */
  version: string;
}

export function parsePluList(data: string): { entries: PluListEntry[]; complete: boolean; digits: 4 | 6 | null } | null {
  if (!data.endsWith("F")) return null;
  const body = data.slice(0, -1);
  if (body === "") return { entries: [], complete: true, digits: null };
  for (const w of [6, 4] as const) {
    const re = new RegExp(`^(N\\d{${w}}V\\d)+$`);
    if (re.test(body)) {
      const entries = [...body.matchAll(new RegExp(`N(\\d{${w}})V(\\d)`, "g"))].map((m) => ({ number: Number(m[1]), version: m[2] }));
      return { entries, complete: true, digits: w };
    }
  }
  return null;
}

/** Firma digital (función 2): F tipo(4) C capacidad(6) S versión(4) P cantidad PLU(5) A accesos(3) D decimales(1). */
export interface SystelSignature {
  productType: string;
  capacityGrams: number;
  protocolVersion: string;
  pluCapacity: number;
  shortcuts: number;
  priceDecimals: number;
}

export function parseSignature(data: string): SystelSignature | null {
  const m = /^F(\d{4})C(\d{6})S(\d{4})P(\d{5})A(\d{3})D(\d)$/.exec(data);
  if (!m) return null;
  return { productType: m[1], capacityGrams: Number(m[2]), protocolVersion: m[3], pluCapacity: Number(m[4]), shortcuts: Number(m[5]), priceDecimals: Number(m[6]) };
}

/** Ping (función 23): "00" + T (actualizada) / D (desactualizada) / S (bloqueada esperando sincronización). */
export function parsePing(data: string): { state: "T" | "D" | "S" } | null {
  const m = /^\d\d([TDS])$/.exec(data);
  return m ? { state: m[1] as "T" | "D" | "S" } : null;
}

/** Configuración completa (función 39): "Ton=1;Gris=0;…". Se guarda entera como respaldo. */
export function parseConfig(data: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of data.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/**
 * Pesos de Patagonia → precio crudo de la balanza, según los decimales que informa
 * la firma digital (0 o 2). null si no entra en 6 números.
 */
export function priceToRaw(pesos: number, decimals: number): number | null {
  if (!Number.isFinite(pesos) || pesos < 0) return null;
  if (decimals !== 0 && decimals !== 2) return null;
  const raw = Math.round(decimals === 2 ? pesos * 100 : pesos);
  return raw <= 999999 ? raw : null;
}

export function rawToPesos(raw: number, decimals: number): number {
  return decimals === 2 ? raw / 100 : raw;
}
