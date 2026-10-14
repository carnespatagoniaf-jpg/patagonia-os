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
  /** Cuándo los informó la balanza (ms). */
  at: number;
}

const KEY = "patagonia-systel-label-templates";

export function saveSystelLabelTemplates(values: Record<string, string>): void {
  const weighed = values.E_P ?? null;
  const unit = values.E_U ?? null;
  if (!weighed && !unit) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ weighed, unit, at: Date.now() } satisfies SystelLabelTemplates));
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
 * El formato con el que hay que leer ESTE código, según el formato que informó la balanza:
 * - el código empieza con los números fijos del formato de pesables o de unitarios → ese formato;
 * - si coincide con uno que Patagonia no entiende → "no_soportado" (no se carga);
 * - si no empieza con ninguno → null (no es una etiqueta de esa balanza; sigue el camino normal).
 */
export function systelConfigForCode(code: string, templates: SystelLabelTemplates | null): ScaleConfig | "no_soportado" | null {
  if (!templates || !/^\d{13}$/.test(code)) return null;
  for (const t of [templates.weighed, templates.unit]) {
    if (!t) continue;
    const fixed = /^\d+/.exec(t)?.[0] ?? "";
    if (fixed && code.startsWith(fixed)) return configFromSystelTemplate(t) ?? "no_soportado";
  }
  return null;
}
