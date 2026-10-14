import { buildCode, fieldLength, matchesTemplate, parseTemplate, readFields, validEan13, type ParsedTemplate } from "./label-template";

/**
 * Perfil de venta de una balanza: lo que imprimen sus códigos y su catálogo (leído de la balanza, solo
 * lectura). Lo comparten todas las cajas de la sucursal (tabla scale_profiles / scale_catalog_items).
 * Sirve para cualquier marca: el driver de cada marca lo arma al leer la balanza.
 */

/** P = pesable, U = unitario, E = escurrido, C = congelado (Systel). */
export type ScaleSaleType = "P" | "U" | "E" | "C";

export interface ScaleCatalogItem {
  /** Código del producto (el que va en el código de barras: campo P). */
  code: number;
  name: string;
  saleType: ScaleSaleType;
  /** Precios de cada lista, en pesos (0 = sin precio en esa lista). */
  prices: number[];
  /** Código de barras del producto: 0 = el general, 1 = el suyo (eanConfig), 2 = ninguno, 3 = suma; null = no se sabe. */
  eanType: number | null;
  eanConfig: string | null;
}

export interface ScaleSaleProfile {
  scaleKey: string;
  brand: string;
  /** Formato general de pesables y unitarios, y el del TOTAL (ej. "20PPPPCCCCCC", "21PPPPCCCCCC", "22AAIIIIIIII"). */
  weighedFormat: string | null;
  unitFormat: string | null;
  totalFormat: string | null;
  /** Decimales del importe (I) en los códigos: 0 = pesos enteros (Systel con precios sin decimales). */
  amountDecimals: number;
  /** Códigos de los productos "venta libre" de la balanza (precio a mano, sin producto). */
  genericCodes: number[];
  catalog: ScaleCatalogItem[];
}

/** Vínculo producto de la balanza → producto de Patagonia, decidido por una persona (o confirmado). */
export interface ScaleLink {
  code: number;
  /** "product": descuenta stock de productId. "libre": se cobra el importe sin producto. "none": no se puede vender. */
  kind: "product" | "libre" | "none";
  productId: string | null;
}

export const isWeighed = (t: ScaleSaleType) => t === "P" || t === "C" || t === "E";

/**
 * Cómo se lee la cantidad de un unitario. El manual dice "C = Cantidad (kg o unidades)" sin decir si las
 * unidades van enteras (000002) o como los kilos (002000). NO CONFIRMADO con una etiqueta real: se aceptan las dos
 * mientras no haya ambigüedad (ver `unitsFromField`). Cuando la primera etiqueta real lo confirme, esto pasa a true
 * con la forma real.
 */
export const UNIT_QUANTITY_ENCODING_CONFIRMED = false;

/** Unidades a partir del campo C de un unitario. null si no se puede saber sin suponer. */
export function unitsFromField(c: number): number | null {
  if (c <= 0) return null;
  if (c < 1000) return c;
  if (c % 1000 === 0) return c / 1000;
  return null;
}

/** Formato con el que imprime ESTE producto, o null si no imprime código. */
export function itemFormat(item: ScaleCatalogItem, profile: ScaleSaleProfile): string | null {
  if (item.eanType === 1) return item.eanConfig && /P/.test(item.eanConfig) ? item.eanConfig : null;
  if (item.eanType === 2 || item.eanType === 3) return null;
  return isWeighed(item.saleType) ? profile.weighedFormat : profile.unitFormat;
}

export type DecodedScan =
  | { kind: "total"; amount: number; articles: number | null; barcode: string }
  | { kind: "item"; code: number; barcode: string; item: ScaleCatalogItem | null; generic: boolean; quantity: number | null; quantityNote?: string }
  | { kind: "not_scale" }
  | { kind: "error"; reason: string };

const unique = <T,>(xs: T[]) => [...new Set(xs)];

/** Todos los formatos de artículo que puede imprimir esta balanza (generales y propios de cada producto). */
function itemTemplates(profile: ScaleSaleProfile): ParsedTemplate[] {
  const texts = unique([profile.weighedFormat, profile.unitFormat, ...profile.catalog.map((i) => (i.eanType === 1 ? i.eanConfig : null))].filter((t): t is string => !!t && /P/.test(t)));
  return texts.map(parseTemplate).filter((t): t is ParsedTemplate => !!t && !!t.fields.P);
}

/**
 * Qué es un código escaneado, según el perfil de la balanza. No consulta productos de Patagonia
 * (eso es el vínculo, en paper.ts).
 */
export function decodeScaleCode(raw: string, profile: ScaleSaleProfile): DecodedScan {
  const code = raw.trim();
  const total = parseTemplate(profile.totalFormat);
  const items = itemTemplates(profile);
  const prefixes = [total, ...items].filter((t): t is ParsedTemplate => !!t).map((t) => t.prefix);
  if (!/^\d{13}$/.test(code) || !prefixes.some((p) => code.startsWith(p))) return { kind: "not_scale" };
  if (!validEan13(code)) return { kind: "error", reason: "el código se leyó con un error (verificador incorrecto): volvé a escanearlo" };

  const isTotal = !!total && matchesTemplate(code, total);
  const itemMatches = items.filter((t) => matchesTemplate(code, t));
  if (isTotal && itemMatches.length > 0) return { kind: "error", reason: "el formato del TOTAL y el de los productos empiezan igual: no se puede saber qué es (hay que cambiar la cabecera en la balanza)" };

  if (isTotal) {
    const f = readFields(code, total!)!;
    if (f.I === undefined) return { kind: "error", reason: "el código del TOTAL no trae el importe" };
    // Todo en 9 = la balanza no pudo poner el importe (no entra en el campo): real Systel, "2211999999994".
    if (String(f.I) === "9".repeat(fieldLength(total!, "I"))) return { kind: "error", reason: "el importe del ticket no entra en el código del TOTAL" };
    return { kind: "total", amount: f.I / 10 ** profile.amountDecimals, articles: f.A ?? null, barcode: code };
  }
  if (itemMatches.length === 0) return { kind: "not_scale" };

  // Con cada formato posible, ¿qué producto dice? Tienen que coincidir todos.
  const codes = unique(itemMatches.map((t) => readFields(code, t)?.P).filter((p): p is number => p !== undefined));
  if (codes.length !== 1) return { kind: "error", reason: "el código se puede leer como productos distintos según el formato: no se carga" };
  const productCode = codes[0];
  const item = profile.catalog.find((i) => i.code === productCode) ?? null;
  const generic = profile.genericCodes.includes(productCode);

  let tpl: ParsedTemplate | null = null;
  if (item) {
    const text = itemFormat(item, profile);
    tpl = parseTemplate(text);
    if (!tpl || !matchesTemplate(code, tpl)) return { kind: "error", reason: `el código no tiene el formato con el que imprime el producto ${productCode} de la balanza` };
  } else {
    // Producto que no está en el catálogo leído: la cantidad solo si todos los formatos posibles la leen igual.
    const qs = unique(itemMatches.map((t) => (t.fields.C ? readFields(code, t)?.C : undefined)));
    tpl = qs.length === 1 && qs[0] !== undefined ? itemMatches[0] : null;
  }
  const c = tpl?.fields.C ? readFields(code, tpl)!.C! : null;
  if (c === null) return { kind: "item", code: productCode, barcode: code, item, generic, quantity: null, quantityNote: "el código no trae la cantidad" };
  if (!item) return { kind: "item", code: productCode, barcode: code, item, generic, quantity: null, quantityNote: "producto que no está en el catálogo leído de la balanza" };
  if (isWeighed(item.saleType)) return { kind: "item", code: productCode, barcode: code, item, generic, quantity: c > 0 ? c / 1000 : null };
  const units = unitsFromField(c);
  return { kind: "item", code: productCode, barcode: code, item, generic, quantity: units, quantityNote: units === null ? `no se puede saber cuántas unidades son (${c})` : undefined };
}

/** Lo que imprimiría la balanza para un artículo (para pruebas y para la pantalla de verificación). */
export function expectedItemCode(item: ScaleCatalogItem, profile: ScaleSaleProfile, quantity: number): string | null {
  const t = parseTemplate(itemFormat(item, profile));
  if (!t || !t.fields.P || !t.fields.C) return null;
  const c = isWeighed(item.saleType) ? Math.round(quantity * 1000) : quantity;
  return buildCode(t, { P: item.code, C: c, I: 0, B: 0, S: 0 });
}

export interface ReadinessProblem {
  code: number;
  name: string;
  problem: "sin_codigo" | "sin_cantidad" | "codigo_no_entra" | "kilos_limitados";
  detail: string;
}

/**
 * ¿Qué productos (vinculados) no pueden venderse escaneando su código, con la configuración actual de la balanza?
 * Es la lista exacta de lo que habría que cambiar en la balanza (nada se cambia desde acá).
 * `maxGrams`: el mayor peso que se vende de verdad (real Los gringos: 14.935 g).
 */
export function profileReadiness(profile: ScaleSaleProfile, links: ScaleLink[], maxGrams = 99999): { problems: ReadinessProblem[]; totalOk: boolean; totalDetail: string } {
  const linked = new Set(links.filter((l) => l.kind !== "none").map((l) => l.code));
  const problems: ReadinessProblem[] = [];
  for (const item of profile.catalog) {
    if (!linked.has(item.code) || profile.genericCodes.includes(item.code)) continue;
    const t = parseTemplate(itemFormat(item, profile));
    const base = { code: item.code, name: item.name.trim() };
    if (!t || !t.fields.P) {
      problems.push({ ...base, problem: "sin_codigo", detail: item.eanType === 1 ? `su código propio es "${item.eanConfig ?? ""}" (sin producto): la balanza imprime ceros` : "no imprime código de barras" });
      continue;
    }
    if (!t.fields.C) {
      problems.push({ ...base, problem: "sin_cantidad", detail: `su código ("${t.text}") no trae la cantidad` });
      continue;
    }
    if (String(item.code).length > fieldLength(t, "P")) {
      problems.push({ ...base, problem: "codigo_no_entra", detail: `el código ${item.code} no entra en ${fieldLength(t, "P")} cifras: la balanza no imprime el código` });
      continue;
    }
    const maxC = 10 ** fieldLength(t, "C") - 1;
    if (isWeighed(item.saleType) && maxC < maxGrams) {
      problems.push({ ...base, problem: "kilos_limitados", detail: `su código ("${t.text}") trae ${fieldLength(t, "C")} cifras de cantidad: hasta ${(maxC / 1000).toLocaleString("es-AR")} kg` });
    }
  }
  const tt = parseTemplate(profile.totalFormat);
  const totalOk = !!tt && !!tt.fields.I;
  const totalDetail = !tt ? "no se conoce el formato del TOTAL" : !tt.fields.I ? `el TOTAL ("${tt.text}") no trae el importe` : !tt.fields.A ? `el TOTAL ("${tt.text}") no trae la cantidad de artículos: no se puede controlar que no falte ninguno` : `TOTAL "${tt.text}": importe y cantidad de artículos`;
  return { problems, totalOk: totalOk && !!tt?.fields.A, totalDetail };
}
