import type { ScaleConfig } from "../sale/scale-barcode";

/**
 * PERFIL DE ETIQUETA DE CADA BALANZA (plan balanzas v2, etapa 2; scale_profiles.label_spec, migración 222).
 *
 * Cada balanza registrada dice, como DATO, cómo imprime sus etiquetas: con qué empieza cada tipo (pesado, unidad,
 * TOTAL), cuántas cifras tienen el producto y el valor, qué trae el valor y qué se le manda para configurarla (el 1070
 * de Kretz o el formato por producto de Systel). Así el código no pregunta QUIÉN es el cliente: pregunta qué perfil
 * tiene la balanza. Reemplaza a las listas por cliente de engine/weight-barcode.ts (se borran cuando 'balanzas_v2'
 * esté encendido para todos).
 *
 * Puro: sin Supabase ni pantallas (label-spec.test.ts). La migración 222 valida la misma forma y la 223 carga los
 * perfiles con las mismas conversiones (las dos se prueban contra este archivo).
 */

/** Qué trae el valor del código: gramos, importe en centavos, importe en pesos enteros, o unidades. */
export type LabelValue = "weight_g" | "amount_cents" | "amount_pesos" | "units";

export type LabelWriter =
  /** Kretz: el código del comando 1070 ("PP T QQ U F": inicio pesable, 1 = peso / 0 = importe, inicio no pesable, ídem, formato). */
  | { kind: "kretz1070"; code: string }
  /** Systel: el código propio que se escribe en cada producto ("20PPPPCCCCCC" pesables, "21PPPPCCCCCC" unitarios). */
  | { kind: "systel"; weighed: string; unit: string };

export interface LabelSpec {
  v: 1;
  /** Con qué empieza cada tipo de etiqueta que imprime ESTA balanza (null = no imprime ese tipo). */
  prefixes: { weighed: string | null; unit: string | null; total: string | null };
  /** Cómo se lee el código: cifras del inicio, del producto y del valor, largo total y divisor del valor. */
  layout: { prefix: number; code: number; value: number; length: number; divisor: number };
  /** Qué trae el valor, leído con `layout`. */
  value: LabelValue;
  /** Lo que traen las etiquetas por kilo, si no es `value` (Report 1070 "21…1…": "21" + gramos). */
  weighedValue?: LabelValue;
  /** Lo que traen las etiquetas por unidad, si no es `value` (Report 2-5-5: "20" + importe en pesos). */
  unitValue?: LabelValue;
  /** Código del producto que la balanza usa para el TOTAL del ticket (Kretz: 998), o null. */
  sumCode: number | null;
  /** Qué se le manda a la balanza para que imprima así. null = lo decide la conexión, como hoy (Report por red o cable). */
  writer: LabelWriter | null;
  /** De dónde salió (solo para soporte): "sucursal", "fabrica", "1070", "asignado"… */
  origin?: string;
}

const VALUES: LabelValue[] = ["weight_g", "amount_cents", "amount_pesos", "units"];
const isPrefix = (p: unknown): p is string => typeof p === "string" && /^2\d?$/.test(p);
const isInt = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

/** ¿Es un perfil bien armado? (la misma regla que valida set_scale_label_spec en la base). null = sí; si no, el motivo. */
export function labelSpecProblem(x: unknown): string | null {
  if (!x || typeof x !== "object") return "no es un perfil";
  const s = x as Partial<LabelSpec>;
  if (s.v !== 1) return "versión desconocida";
  const p = s.prefixes;
  if (!p || typeof p !== "object") return "faltan los inicios";
  for (const k of ["weighed", "unit", "total"] as const) {
    if (p[k] !== null && !isPrefix(p[k])) return `inicio ${k} inválido`;
  }
  if (p.weighed === null && p.unit === null) return "no tiene ningún inicio de etiqueta";
  const l = s.layout;
  if (!l || !isInt(l.prefix, 0, 2) || !isInt(l.code, 1, 6) || !isInt(l.value, 1, 8) || !isInt(l.length, 8, 13)) return "cifras inválidas";
  if (l.prefix + l.code + l.value > l.length - 1) return "las cifras no entran en el largo";
  if (![1, 10, 100, 1000].includes(l.divisor as number)) return "divisor inválido";
  if (!VALUES.includes(s.value as LabelValue)) return "valor inválido";
  if (s.weighedValue !== undefined && !VALUES.includes(s.weighedValue)) return "valor de pesables inválido";
  if (s.unitValue !== undefined && !VALUES.includes(s.unitValue)) return "valor de unitarios inválido";
  if (s.sumCode !== null && !isInt(s.sumCode, 1, 999999)) return "código de TOTAL inválido";
  const w = s.writer;
  if (w !== null) {
    if (!w || typeof w !== "object") return "escritura inválida";
    if (w.kind === "kretz1070") {
      if (!/^2\d[01]2\d[01][15]$/.test(w.code)) return "1070 inválido";
    } else if (w.kind === "systel") {
      if (!/^2\d[PCI]{10}$/.test(w.weighed) || !/^2\d[PCI]{10}$/.test(w.unit)) return "formato Systel inválido";
    } else return "escritura inválida";
  }
  return null;
}

export function isLabelSpec(x: unknown): x is LabelSpec {
  return labelSpecProblem(x) === null;
}

/** Los inicios distintos que usa la balanza (los que reserva en scale_label_prefixes). */
export function specPrefixes(spec: LabelSpec): string[] {
  return [...new Set([spec.prefixes.weighed, spec.prefixes.unit, spec.prefixes.total].filter((p): p is string => p !== null))];
}

/** ¿Dos inicios se pisan? ("2" se pisa con "20"…"29"; "20" con "20"). */
export function prefixesOverlap(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

const payloadOf = (v: LabelValue) => (v === "amount_cents" || v === "amount_pesos" ? "amount" : "weight");

/**
 * Inicio propio de una Kretz con el 2-3-7 en centavos (22 a 29): Mostrador lee "PP" + producto 3 + centavos 7 y el
 * producto 998 es el TOTAL (comprobado con "22" en la Aura real, 25/11/2026).
 */
export function kretzOwnPrefix(spec: LabelSpec): string | null {
  const w = spec.prefixes.weighed;
  if (!w || !/^2[2-9]$/.test(w) || spec.prefixes.unit !== w) return null;
  const l = spec.layout;
  if (l.prefix !== 2 || l.code !== 3 || l.value !== 7 || l.length !== 13 || l.divisor !== 100 || spec.value !== "amount_cents") return null;
  return w;
}

/** Inicio de las etiquetas por unidad de una Systel con inicio propio (el mismo que el de los pesables). */
function systelUnitPrefix(spec: LabelSpec): string | null {
  if (spec.writer?.kind !== "systel") return null;
  const u = spec.prefixes.unit;
  return u && u !== "21" ? u : null;
}

/** Cómo lee Mostrador las etiquetas de esta balanza (el ScaleConfig de scan-resolve.ts). */
export function specToScaleConfig(spec: LabelSpec): ScaleConfig {
  const l = spec.layout;
  const config: ScaleConfig = { prefixLength: l.prefix, pluLength: l.code, weightLength: l.value, weightDivisor: l.divisor, totalLength: l.length, payloadType: payloadOf(spec.value) };
  const own = kretzOwnPrefix(spec);
  if (own) config.ownPrefix = own;
  const unit = systelUnitPrefix(spec);
  if (unit) config.unitPrefix = unit;
  return config;
}

/** Clave de lectura: dos perfiles con la misma clave leen igual cualquier código. */
export function readKey(spec: LabelSpec): string {
  const c = specToScaleConfig(spec);
  return [c.prefixLength, c.pluLength, c.weightLength, c.weightDivisor, c.totalLength, c.payloadType, c.ownPrefix ?? "", c.unitPrefix ?? ""].join("|");
}

function valueOfDivisor(payload: "weight" | "amount", divisor: number): LabelValue {
  if (payload === "weight") return "weight_g";
  return divisor === 1 ? "amount_pesos" : "amount_cents";
}

// ------------------------------------------------------------------------------------------------ Kretz 1070

/** El 2-3-7 con importe en centavos que Patagonia les manda a las Kretz (1070 "2002005"). */
const KRETZ_237: Omit<LabelSpec, "prefixes" | "writer"> = { v: 1, layout: { prefix: 2, code: 3, value: 7, length: 13, divisor: 100 }, value: "amount_cents", sumCode: 998 };

/**
 * El perfil que deja una Kretz al recibir ese 1070, con EXACTAMENTE la lectura que Mostrador usa hoy para ese formato:
 * - "PP0PP05" (PP = 20, o 22-29): 2-3-7 en centavos, TOTAL 998 (Aura y Report por cable).
 * - "2112005": "21" + gramos 7 en los pesables y "20" + centavos en los unitarios (lectura 2-3-7 con importe; la de los
 *   "21" la hace scan-resolve).
 * - "2112001": "21" + producto 5 + gramos 5 y "20" + producto 5 + pesos (Report por red; lectura 2-5-5 con peso).
 * - "2002001": "20" + producto 5 + pesos 5 (lectura 1-6-5 en pesos, los mismos dígitos).
 * Otro: null (no se sabe leerlo sin riesgo).
 */
export function specFromKretz1070(code: string): LabelSpec | null {
  const m = /^(2\d)([01])(2\d)([01])([15])$/.exec(code);
  if (!m) return null;
  const [, wp, wt, up, ut, fmt] = m;
  const writer: LabelWriter = { kind: "kretz1070", code };
  if (fmt === "5" && wt === "0" && ut === "0" && wp === up && (wp === "20" || /^2[2-9]$/.test(wp))) {
    return { ...KRETZ_237, prefixes: { weighed: wp, unit: up, total: wp }, writer, origin: "1070" };
  }
  if (fmt === "5" && wp === "21" && wt === "1" && up === "20" && ut === "0") {
    return { ...KRETZ_237, prefixes: { weighed: "21", unit: "20", total: "20" }, weighedValue: "weight_g", writer, origin: "1070" };
  }
  if (fmt === "1" && wp === "21" && wt === "1" && up === "20" && ut === "0") {
    return { v: 1, prefixes: { weighed: "21", unit: "20", total: "20" }, layout: { prefix: 2, code: 5, value: 5, length: 13, divisor: 1000 }, value: "weight_g", unitValue: "amount_pesos", sumCode: null, writer, origin: "1070" };
  }
  if (fmt === "1" && wp === "20" && wt === "0" && up === "20" && ut === "0") {
    return { v: 1, prefixes: { weighed: "20", unit: "20", total: "20" }, layout: { prefix: 1, code: 6, value: 5, length: 13, divisor: 1 }, value: "amount_pesos", sumCode: 99998, writer, origin: "1070" };
  }
  return null;
}

/** El 1070 que corresponde a un perfil Kretz (el guardado, o el que se arma con un inicio propio). */
export function kretz1070ForSpec(spec: LabelSpec): string | null {
  return spec.writer?.kind === "kretz1070" ? spec.writer.code : null;
}

// ------------------------------------------------------------------------------------------------ Systel

export const SYSTEL_WEIGHED_CODE = "20PPPPCCCCCC";
export const SYSTEL_UNIT_CODE = "21PPPPCCCCCC";

/** Los códigos propios que se escriben en cada producto de ESTA Systel. */
export function systelTicketCodes(spec: LabelSpec | null | undefined): { weighed: string; unit: string } {
  if (spec?.writer?.kind === "systel") return { weighed: spec.writer.weighed, unit: spec.writer.unit };
  return { weighed: SYSTEL_WEIGHED_CODE, unit: SYSTEL_UNIT_CODE };
}

/** El perfil de una Systel a la que Patagonia le escribe el formato por producto (20/21 + producto 4 + cantidad 6). */
export function systelSpec(totalFormat: string | null, prefix: string | null = null): LabelSpec {
  const total = totalFormat && /^2\d/.test(totalFormat) ? totalFormat.slice(0, 2) : null;
  const w = prefix ?? "20";
  const u = prefix ?? "21";
  return {
    v: 1,
    prefixes: { weighed: w, unit: u, total: total && total !== w && total !== u ? total : null },
    layout: { prefix: 2, code: 4, value: 6, length: 13, divisor: 1000 },
    value: "weight_g",
    unitValue: "units",
    sumCode: null,
    writer: { kind: "systel", weighed: `${w}PPPPCCCCCC`, unit: `${u}PPPPCCCCCC` },
    origin: prefix ? "asignado" : "systel"
  };
}

// ------------------------------------------------------------------------------------------------ desde hoy

export type ScaleFamilyName = "kretz" | "systel";

/** ¿Es una Aura? (scale_profiles.model: "Kretz Aura"). */
export const isAuraModel = (model: string | null | undefined) => /aura/i.test(model ?? "");

/**
 * Las 4 listas por cliente de engine/weight-barcode.ts, como DATO (sin identificadores): qué 1070 le manda hoy el
 * código a esa balanza. La migración 223 elige cuál corresponde a cada balanza con los UUID.
 */
export const LEGACY_LIST_1070 = {
  /** REPORT_WEIGHT_BARCODE_COMPANIES: Report con "21" + gramos (1070 "2112005"). */
  report_peso: "2112005",
  /** REPORT_PESOS_BARCODE_COMPANIES: Report con "20" + pesos enteros (1070 "2002001"). */
  report_pesos: "2002001",
  /** REPORT_PLU5_WEIGHT_COMPANIES: Report por cable igual que por red (1070 "2112001"). */
  report_plu5: "2112001",
  /** AURA_PREFIX_22_BRANCHES: Aura con inicio 22 (1070 "2202205"). */
  aura_22: "2202205"
} as const;
export type LegacyList = keyof typeof LEGACY_LIST_1070;

/**
 * Perfil de una balanza ya registrada con EXACTAMENTE lo que el código hace hoy (lo que carga la migración 223):
 * - de una lista por cliente: el perfil de su 1070 (la lectura de esa lista);
 * - si no: el formato de la sucursal (o el de fábrica si no tiene) como lectura, y como escritura lo que se le manda
 *   hoy (Aura: "2002005"; Systel: 20/21 + producto 4 + cantidad 6; Report: lo decide la conexión → null).
 */
export function specFromToday(input: { family: ScaleFamilyName; model: string | null; branchConfig: ScaleConfig | null; list?: LegacyList | null; totalFormat?: string | null }): LabelSpec {
  if (input.list) return specFromKretz1070(LEGACY_LIST_1070[input.list])!;
  const c = input.branchConfig ?? { prefixLength: 1, pluLength: 5, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" as const };
  const read = {
    layout: { prefix: c.prefixLength, code: c.pluLength, value: c.weightLength, length: c.totalLength, divisor: c.weightDivisor },
    value: valueOfDivisor(c.payloadType, c.weightDivisor),
    origin: input.branchConfig ? "sucursal" : "fabrica"
  };
  if (input.family === "systel") {
    const s = systelSpec(input.totalFormat ?? null);
    return { ...s, ...read, unitValue: "units" };
  }
  const aura = isAuraModel(input.model);
  // Una Kretz imprime "2…": con inicio de 2 cifras, el que le manda Patagonia (20); con 1 cifra, "2".
  const p = c.prefixLength === 2 ? "20" : "2";
  return {
    v: 1,
    prefixes: { weighed: p, unit: p, total: p },
    ...read,
    sumCode: aura ? 998 : null,
    writer: aura ? { kind: "kretz1070", code: "2002005" } : null
  };
}

// ------------------------------------------------------------------------------------------------ inicio propio

/** Inicios que se le pueden asignar a una balanza de esa marca cuando el suyo ya lo usa otra del local. */
export function allocatablePrefixes(family: ScaleFamilyName): string[] {
  // Kretz: el 1070 acepta cualquier inicio "2x" (22 comprobado en la Aura real; 22-29 en la Report, a confirmar en el
  // banco). Systel: el TOTAL de la Cuora sale con "22" (E_S de fábrica): ese no se le da a nadie.
  return family === "kretz" ? ["22", "23", "24", "25", "26", "27", "28", "29"] : ["23", "24", "25", "26", "27", "28", "29"];
}

/**
 * El perfil de una balanza con un inicio propio (lo que arma allocate_scale_prefix en la base):
 * - Kretz: 2-3-7 en centavos con ese inicio para pesables y unitarios, TOTAL 998 (1070 "PP0PP05").
 * - Systel: ese inicio para pesables y unitarios + producto 4 + cantidad 6.
 */
export function specWithOwnPrefix(family: ScaleFamilyName, prefix: string, totalFormat: string | null = null): LabelSpec {
  if (family === "systel") return systelSpec(totalFormat, prefix);
  return { ...specFromKretz1070(`${prefix}0${prefix}05`)!, origin: "asignado" };
}

// ------------------------------------------------------------------------------------------------ perfiles vigentes

/** Un perfil que Mostrador prueba al leer: el actual de una balanza activa, o uno anterior todavía vigente (7 días). */
export interface ScaleLabelProfile {
  scaleKey: string;
  name: string | null;
  spec: LabelSpec;
  /** null = el actual; si no, hasta cuándo vale el anterior (etiquetas ya impresas en la heladera). */
  validUntil: string | null;
}

export interface LabelSpecRow {
  scale_key: string;
  name?: string | null;
  status?: string | null;
  label_spec: unknown;
  label_spec_history?: unknown;
}

/** Los perfiles a probar en una sucursal: el actual de cada balanza activa + los anteriores que todavía valen. */
export function activeLabelProfiles(rows: LabelSpecRow[], now: Date = new Date()): ScaleLabelProfile[] {
  const current: ScaleLabelProfile[] = [];
  const previous: ScaleLabelProfile[] = [];
  for (const r of rows) {
    if ((r.status ?? "active") !== "active") continue;
    if (isLabelSpec(r.label_spec)) current.push({ scaleKey: r.scale_key, name: r.name ?? null, spec: r.label_spec, validUntil: null });
    const history = Array.isArray(r.label_spec_history) ? r.label_spec_history : [];
    for (const h of history as { spec?: unknown; valid_until?: unknown }[]) {
      if (!h || !isLabelSpec(h.spec) || typeof h.valid_until !== "string") continue;
      if (!(new Date(h.valid_until).getTime() > now.getTime())) continue;
      previous.push({ scaleKey: r.scale_key, name: r.name ?? null, spec: h.spec, validUntil: h.valid_until });
    }
  }
  return [...current, ...previous];
}
