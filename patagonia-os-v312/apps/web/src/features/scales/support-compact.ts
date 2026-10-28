/**
 * El diagnóstico que va a soporte entra en 60.000 letras (la base corta ahí). Antes se cortaba el texto a lo bruto y
 * quedaba un JSON roto, sin el final (real Giuseppe 27/10: se perdió por qué frenó). Ahora se acortan las listas
 * largas guardando el principio y el final, y el resultado siempre es un JSON válido. Sin dependencias, testeado.
 */
export const SUPPORT_LOG_MAX = 60000;

type Json = Record<string, unknown>;

function trimArray(list: unknown[], keep: number): unknown[] {
  if (list.length <= keep * 2) return list;
  return [...list.slice(0, keep), `… ${list.length - keep * 2} renglones del medio no entraron …`, ...list.slice(-keep)];
}

function trimDeep(value: unknown, keep: number, maxText: number): unknown {
  if (Array.isArray(value)) return trimArray(value, keep).map((v) => trimDeep(v, keep, maxText));
  if (typeof value === "string") return value.length > maxText ? `${value.slice(0, maxText / 2)}…${value.slice(-maxText / 2)}` : value;
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) out[k] = trimDeep(v, keep, maxText);
    return out;
  }
  return value;
}

/** JSON del diagnóstico que entra en `max` letras, siempre válido. */
export function compactSupportLog(diagnostic: Json, max = SUPPORT_LOG_MAX): string {
  const full = JSON.stringify(diagnostic);
  if (full.length <= max) return full;
  for (const [keep, maxText] of [[150, 4000], [80, 2000], [40, 1000], [20, 500], [8, 200]] as const) {
    const text = JSON.stringify({ ...(trimDeep(diagnostic, keep, maxText) as Json), recortado: { largo_original: full.length } });
    if (text.length <= max) return text;
  }
  // Último recurso: lo esencial (qué pasó, dónde y con qué balanza).
  const { cuando, etapa, mensaje, balanza, tecnico, cable, version } = diagnostic;
  return JSON.stringify({ cuando, etapa, mensaje, balanza, tecnico: String(tecnico ?? "").slice(0, 2000), cable, version, recortado: { largo_original: full.length, solo_lo_esencial: true } }).slice(0, max);
}
