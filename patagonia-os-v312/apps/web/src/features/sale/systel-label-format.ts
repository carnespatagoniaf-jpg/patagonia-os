import type { ScaleConfig } from "./scale-barcode";

/**
 * Formato del código de barras de cada producto de una balanza Systel, tal como lo informa la propia
 * balanza (configuración, función 39: E_P = pesables, E_U = unitarios; 12 caracteres + verificador).
 * Letras del manual de la Cuora Max: P = código del producto, C = cantidad (gramos o unidades),
 * I = importe, S = sección, B = N.º de balanza, números = fijos.
 *
 * Por qué: la balanza de Los gringos tenía "20PPPPCCCCCC" el 09/10 y "20PPPPCCCCII" el 13/10 (alguien lo
 * cambió en el menú). Con el formato viejo, un código nuevo de 0,215 kg con importe terminado en 18
 * ("20 0005 0215 18") se leería 21,518 kg. Por eso, si la balanza informó su formato, se usa ESE.
 *
 * Solo se aceptan formatos que Patagonia entiende sin suponer nada: números fijos al principio, después
 * el producto (P) y después la cantidad (C); lo que sigue (I, S, B o números) se ignora. Cualquier otro
 * orden, o sin cantidad, devuelve null y la etiqueta NO se carga sola.
 */
export function configFromSystelTemplate(template: string): ScaleConfig | null {
  const m = /^(\d+)(P+)(C+)([0-9IBS]*)$/.exec(template);
  if (!m || template.length !== 12) return null;
  return { prefixLength: m[1].length, pluLength: m[2].length, weightLength: m[3].length, weightDivisor: 1000, totalLength: 13, payloadType: "weight" };
}

export interface SystelLabelTemplates {
  weighed: string | null;
  unit: string | null;
  /** Formato del código del TOTAL (E_S, ej. "22AAIIIIIIII"): dice cuántos artículos tiene el ticket. */
  sums?: string | null;
  /** Cuándo los informó la balanza (ms). */
  at: number;
  /**
   * Código de barras PROPIO de cada producto (función 62), por código de producto: tipo 0 = usa el general,
   * 1 = el suyo (`config`), 2 = ninguno, 3 = suma. REAL Los gringos 14/10: el 13 tiene "20PPPPCCCCCC" (6 cifras
   * de cantidad) mientras el general es "20PPPPCCCCII" (4): leerlo con el general daría otros kilos.
   */
  perPlu?: Record<string, { type: number | null; config: string | null; p1?: number; p2?: number; name?: string; saleType?: string }>;
}

const KEY = "patagonia-systel-label-templates";

export function saveSystelLabelTemplates(values: Record<string, string>): void {
  const weighed = values.E_P ?? null;
  const unit = values.E_U ?? null;
  if (!weighed && !unit) return;
  try {
    const prev = loadSystelLabelTemplates();
    localStorage.setItem(KEY, JSON.stringify({ weighed, unit, sums: values.E_S ?? null, at: Date.now(), perPlu: prev?.perPlu } satisfies SystelLabelTemplates));
  } catch {
    // sin localStorage se usa el formato de la sucursal
  }
}

export function loadSystelLabelTemplates(): SystelLabelTemplates | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SystelLabelTemplates) : null;
  } catch {
    return null;
  }
}

/**
 * Guarda el código de barras propio de los productos leídos de la balanza (se suma a lo ya guardado).
 * `replace`: reemplaza todo lo guardado (lectura completa de la balanza). REAL El Dorado 29/10: un formato viejo
 * guardado en la PC ("producto + kilos") leyó una etiqueta de "producto + importe" ($99.934) como 99,934 kg.
 */
export function saveSystelPluBarcodes(perPlu: Record<string, { type: number | null; config: string | null; p1?: number; p2?: number; name?: string; saleType?: string }>, replace = false): void {
  try {
    const prev = loadSystelLabelTemplates() ?? { weighed: null, unit: null, at: Date.now() };
    localStorage.setItem(KEY, JSON.stringify({ ...prev, perPlu: replace ? perPlu : { ...(prev.perPlu ?? {}), ...perPlu } } satisfies SystelLabelTemplates));
  } catch {
    // nada
  }
}

const fixedPrefix = (t: string) => /^\d+/.exec(t)?.[0] ?? "";
const pluSlice = (t: string) => {
  const a = t.indexOf("P");
  return a < 0 ? null : [a, t.lastIndexOf("P") + 1] as const;
};

/**
 * El formato con el que hay que leer ESTE código, según lo que informó la balanza:
 * - formatos posibles: el general de pesables y de unitarios, y el propio de cada producto leído (tipo 1);
 *   se quedan los que empiezan con los mismos números fijos que el código;
 * - si no queda ninguno → null (no es una etiqueta de esa balanza; sigue el camino normal);
 * - con esos formatos se lee el N.º de producto; si dan productos distintos → "no_soportado";
 * - si ese producto tiene su propio formato (tipo 1) se usa ése; si usa el general (tipo 0), el general;
 * - si no se sabe qué usa ese producto y los formatos posibles leen distinto la cantidad → "no_soportado"
 *   (no se arriesga a cargar mal los kilos).
 */
export function systelConfigForCode(code: string, templates: SystelLabelTemplates | null): ScaleConfig | "no_soportado" | null {
  if (!templates || !/^\d{13}$/.test(code)) return null;
  const general = [templates.weighed, templates.unit].filter((t): t is string => !!t && code.startsWith(fixedPrefix(t)) && fixedPrefix(t) !== "");
  const own = Object.values(templates.perPlu ?? {})
    .filter((e) => e.type === 1 && e.config && e.config.includes("P"))
    .map((e) => e.config as string)
    .filter((t) => fixedPrefix(t) !== "" && code.startsWith(fixedPrefix(t)));
  const candidates = [...new Set([...general, ...own])];
  if (candidates.length === 0) return null;
  const plus = new Set(candidates.map((t) => {
    const sl = pluSlice(t);
    return sl ? String(Number(code.slice(sl[0], sl[1]))) : "?";
  }));
  if (plus.size !== 1 || plus.has("?")) return "no_soportado";
  const plu = [...plus][0];
  const entry = templates.perPlu?.[plu];
  if (entry && entry.type === 1) return entry.config && entry.config.includes("P") ? configFromSystelTemplate(entry.config) ?? "no_soportado" : "no_soportado";
  if (entry && entry.type === 0) return general.length === 1 ? configFromSystelTemplate(general[0]) ?? "no_soportado" : "no_soportado";
  if (entry && entry.type !== null) return "no_soportado";
  // No se sabe qué formato usa ese producto: solo si todos los posibles leen igual.
  const configs = candidates.map((t) => configFromSystelTemplate(t));
  if (configs.some((c) => !c)) return "no_soportado";
  const first = JSON.stringify(configs[0]);
  return configs.every((c) => JSON.stringify(c) === first) ? configs[0] : "no_soportado";
}

/** Lo mínimo de una balanza registrada en la sucursal (scale_profiles + scale_catalog_items, ver loadScaleSetups). */
export interface RegisteredScaleFormats {
  profile: {
    brand: string;
    weighedFormat: string | null;
    unitFormat: string | null;
    totalFormat: string | null;
    catalog: Array<{ code: number; name: string; saleType: string; prices: number[]; eanType: number | null; eanConfig: string | null }>;
  };
}

/**
 * Formatos de etiqueta de cada balanza Systel ACTIVA de la sucursal, leídos de la base (auditoría 29/10/2026). Antes
 * Mostrador usaba una sola copia guardada en la PC, sin empresa ni sucursal ni balanza: real Los gringos, la misma
 * sucursal tiene una ficha vieja "20PPPPCCCCII" y la actual "20PPPPCCCCCC"; leer con la equivocada da otros kilos.
 */
export function templatesFromSetups(setups: RegisteredScaleFormats[]): SystelLabelTemplates[] {
  return setups
    .filter((s) => s.profile.brand.toLowerCase().includes("systel") && (s.profile.weighedFormat || s.profile.unitFormat))
    .map((s) => ({
      weighed: s.profile.weighedFormat,
      unit: s.profile.unitFormat,
      sums: s.profile.totalFormat,
      at: 0,
      perPlu: Object.fromEntries(
        s.profile.catalog.map((c) => [String(c.code), { type: c.eanType, config: c.eanConfig, p1: c.prices[0] ?? 0, p2: c.prices[1] ?? 0, name: c.name, saleType: c.saleType }])
      )
    }));
}

/**
 * Formato para leer una etiqueta con TODAS las balanzas Systel de la sucursal: si solo una la reconoce, esa; si
 * varias la reconocen y leen igual, esa; si leen distinto, "no_soportado" (nunca se adivina con plata y kilos).
 */
export function systelConfigForCodeAcross(code: string, list: SystelLabelTemplates[]): ScaleConfig | "no_soportado" | null {
  const results = list.map((t) => systelConfigForCode(code, t)).filter((r) => r !== null);
  if (results.length === 0) return null;
  if (results.some((r) => r === "no_soportado")) return "no_soportado";
  const first = JSON.stringify(results[0]);
  return results.every((r) => JSON.stringify(r) === first) ? (results[0] as ScaleConfig) : "no_soportado";
}

/** Datos de cada producto (nombre, forma de venta, precio) juntando las balanzas; el primero que lo tenga. */
export function mergedPerPlu(list: SystelLabelTemplates[]): NonNullable<SystelLabelTemplates["perPlu"]> {
  const out: NonNullable<SystelLabelTemplates["perPlu"]> = {};
  for (const t of list) for (const [plu, e] of Object.entries(t.perPlu ?? {})) if (!(plu in out)) out[plu] = e;
  return out;
}
