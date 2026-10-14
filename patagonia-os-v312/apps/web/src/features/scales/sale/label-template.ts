/**
 * Formatos de código de barras de balanza, para cualquier marca.
 *
 * Un formato tiene 12 caracteres (el 13.º del EAN-13 es el verificador). Cada carácter es:
 * - un número fijo;
 * - o una letra de campo:
 *   - P = código del producto;
 *   - C = cantidad (gramos o unidades);
 *   - I = importe;
 *   - A = cantidad de artículos del ticket;
 *   - B = N.º de balanza;
 *   - S = sección;
 *   - T = N.º de ticket (ninguna balanza conocida lo tiene hoy; queda previsto para la modalidad de un solo código).
 *
 * Fuente: manual Cuora Max ("Configuración del código de barras", págs. 41-43) y protocolo Cuora Max V6.0/V7.0,
 * función 8. Ej. Systel: "20PPPPCCCCCC" (pesable), "21PPPPCCCCCC" (unitario), "22AAIIIIIIII" (TOTAL).
 *
 * Puro: sin navegador ni Supabase.
 */

export type TemplateLetter = "P" | "C" | "I" | "A" | "B" | "S" | "T";

export interface ParsedTemplate {
  text: string;
  /** Números fijos del principio (la "cabecera", ej. "20"). */
  prefix: string;
  /** Posición [desde, hasta) de cada campo. Un campo partido en dos lugares no se acepta. */
  fields: Partial<Record<TemplateLetter, readonly [number, number]>>;
  /** Posiciones de números fijos después de la cabecera (se comparan también). */
  fixed: Array<readonly [number, string]>;
}

const LETTERS = new Set(["P", "C", "I", "A", "B", "S", "T"]);

export function parseTemplate(text: string | null | undefined): ParsedTemplate | null {
  if (!text || text.length !== 12) return null;
  const prefix = /^\d*/.exec(text)![0];
  if (prefix.length === 0) return null;
  const fields: ParsedTemplate["fields"] = {};
  const fixed: ParsedTemplate["fixed"] = [];
  for (let i = prefix.length; i < 12; i++) {
    const ch = text[i];
    if (/\d/.test(ch)) {
      fixed.push([i, ch]);
      continue;
    }
    // "X" o cualquier otra letra que no conocemos: el formato no se entiende y no se usa.
    if (!LETTERS.has(ch)) return null;
    const letter = ch as TemplateLetter;
    if (fields[letter]) return null;
    let end = i;
    while (end < 12 && text[end] === ch) end++;
    // La misma letra de nuevo más adelante = campo partido: no se acepta.
    if (text.indexOf(ch, end) >= 0) return null;
    fields[letter] = [i, end] as const;
    i = end - 1;
  }
  return { text, prefix, fields, fixed };
}

/** Código EAN-13 con verificador correcto. */
export function validEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const d = code.split("").map(Number);
  const sum = d.slice(0, 12).reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === d[12];
}

/** Los 12 primeros números + el verificador. */
export function withCheckDigit(first12: string): string {
  const s = first12.split("").map(Number).reduce((a, d, i) => a + d * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (s % 10)) % 10);
}

/** ¿El código tiene la cabecera y los números fijos de este formato? */
export function matchesTemplate(code: string, t: ParsedTemplate): boolean {
  return /^\d{13}$/.test(code) && code.startsWith(t.prefix) && t.fixed.every(([i, ch]) => code[i] === ch);
}

/** Valor numérico de cada campo del formato, o null si el código no es de este formato. */
export function readFields(code: string, t: ParsedTemplate): Partial<Record<TemplateLetter, number>> | null {
  if (!validEan13(code) || !matchesTemplate(code, t)) return null;
  const out: Partial<Record<TemplateLetter, number>> = {};
  for (const [letter, range] of Object.entries(t.fields) as Array<[TemplateLetter, readonly [number, number]]>) {
    out[letter] = Number(code.slice(range[0], range[1]));
  }
  return out;
}

/** Arma el código que imprimiría la balanza (para pruebas y para mostrar un ejemplo). null si un valor no entra. */
export function buildCode(t: ParsedTemplate, values: Partial<Record<TemplateLetter, number>>): string | null {
  const chars = t.text.split("");
  for (const [letter, range] of Object.entries(t.fields) as Array<[TemplateLetter, readonly [number, number]]>) {
    const v = values[letter] ?? 0;
    const s = String(Math.round(v)).padStart(range[1] - range[0], "0");
    // Como la balanza: si el valor no entra, no imprime el código (manual Cuora Max, pág. 42).
    if (s.length > range[1] - range[0] || v < 0) return null;
    for (let i = range[0]; i < range[1]; i++) chars[i] = s[i - range[0]];
  }
  return withCheckDigit(chars.join(""));
}

/** Largo de un campo (0 si no está). */
export function fieldLength(t: ParsedTemplate, letter: TemplateLetter): number {
  const r = t.fields[letter];
  return r ? r[1] - r[0] : 0;
}
