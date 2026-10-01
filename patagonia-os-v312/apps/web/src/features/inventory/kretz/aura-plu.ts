/**
 * Formato de un PLU de la Kretz Aura, tal como lo devuelve el comando 5005.
 *
 * COMPROBADO con una Aura real (cliente "Pollo y mar", 2026-10-01, modelo
 * AUI-030KMFBAPP4KAR, firmware V1.00 6Feb24): 5005 "000000" devolvió el
 * registro de 42 caracteres "000001FRUTILLA        P0000100010500000005"
 * (grupo "05", código "01", checksum correcto).
 *
 * HIPÓTESIS sobre cómo se reparte (falta comprobar contra lo que muestra o
 * imprime la balanza): 6 + 16 + 1 + 6 + 6 + 4 + 3 = 42. Coincide con los
 * límites del manual (§8.2: nombre hasta 16 letras, código hasta 6 dígitos,
 * precio hasta 6, tara hasta 4, validez 0 a 250 días). Lo que todavía no se
 * sabe con certeza:
 * - si el orden es código → precio (como se asume acá) o precio → código;
 * - cuántos decimales tiene el precio (el visor de la Aura muestra "0.00");
 * - qué letras usa el tipo ("P" = pesable es lo más probable; ¿"U" = unitario?).
 * Por eso nada de esto se usa para ESCRIBIR hasta confirmarlo.
 */

export const AURA_PLU_RECORD_LENGTH = 42;

/** Campos en orden: [nombre, ancho]. */
export const AURA_PLU_LAYOUT: [string, number][] = [
  ["plu", 6],
  ["nombre", 16],
  ["tipo", 1],
  ["codigo", 6],
  ["precio", 6],
  ["tara", 4],
  ["validez", 3]
];

export interface AuraPluRecord {
  plu: number;
  name: string;
  /** Letra de tipo tal cual vino ("P" en el registro real). */
  type: string;
  code: string;
  /** Precio tal cual (6 dígitos, sin saber todavía los decimales). */
  priceRaw: string;
  tareRaw: string;
  validityDays: number;
  raw: string;
}

export function parseAuraPlu(data: string): AuraPluRecord | null {
  if (data.length !== AURA_PLU_RECORD_LENGTH) return null;
  const parts: Record<string, string> = {};
  let at = 0;
  for (const [name, width] of AURA_PLU_LAYOUT) {
    parts[name] = data.slice(at, at + width);
    at += width;
  }
  if (!/^\d{6}$/.test(parts.plu)) return null;
  return {
    plu: Number(parts.plu),
    name: parts.nombre.trimEnd(),
    type: parts.tipo,
    code: parts.codigo,
    priceRaw: parts.precio,
    tareRaw: parts.tara,
    validityDays: Number(parts.validez),
    raw: data
  };
}

/** Precio para mostrar con 0 y con 2 decimales (hasta confirmar cuál es). */
export function auraPriceCandidates(priceRaw: string): { sinDecimales: number; conDosDecimales: number } {
  const n = Number(priceRaw);
  return { sinDecimales: n, conDosDecimales: n / 100 };
}
