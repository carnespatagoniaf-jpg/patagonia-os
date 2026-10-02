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

/*
 * Evidencia del reparto con los 6 PLU reales de la clienta (2026-10-02):
 * - El reparto 6+16+1+6+6+4+3 coincide con los anchos del manual (§8.2).
 * - Da valores razonables en los 6: "PAN NEGRO" tara 0100 (100 g) y validez
 *   001 día, "FRUTILLA" validez 5 días, "PASTELITOS" (N = por unidad) 3 días.
 * - El "código" sigue siempre el patrón PLU × 10 (000010, 000020, 000110).
 * PENDIENTE: el precio. FRUTILLA guarda 001050 y la clienta dice $10.500/kg,
 * así que hay un factor (×10 o decimales) que se confirma con el PLU de
 * prueba: se escribe un precio conocido y se mira qué muestra la balanza.
 */

/*
 * Letra y código: lo que se sabe (2026-10-02, 2 pruebas reales, 5 escrituras).
 * - El manual (§8.2.2) solo tiene PESA = Sí/No. El documento de la Report NX lista P, N y R; D y C no figuran.
 * - En los 6 productos reales: P, N, P, D, C, D, con código = PLU seguido de "0".
 * - DESCARTADA (2026-10-02 12:59) la hipótesis H1 "la letra sale de pesable + validez":
 *   con 2005 la balanza guardó SIEMPRE "D" y código "000000", se mandara P, N, C o D
 *   y código 97, 98, 96 o 500. Nombre, precio, tara y validez sí se guardan tal cual.
 * - "D" se vende por kilo (tickets reales T.0029 y T.0030).
 * - Cómo se escriben la letra y el código con 2005 en la Aura es DESCONOCIDO (no hay
 *   protocolo público de la Aura). Tramas reales y el modelo de lo observado:
 *   aura-real-frames.test.ts.
 * El precio va en pesos enteros (1234 → "1234 $/kg", comprobado en pantalla).
 */
export type AuraTypeLetter = "P" | "N" | "D" | "C";


export interface AuraPluInput {
  plu: number;
  name: string;
  type: AuraTypeLetter;
  /** Precio en pesos enteros (comprobado con la pantalla de la balanza). */
  priceRaw: number;
  /** Código del producto (5 dígitos). Por defecto, el mismo número de PLU, como en los 6 reales. */
  code?: number;
  tareGrams?: number;
  validityDays?: number;
}

/** Arma el registro de 42 caracteres, con el mismo formato que devuelve 5005. Tira error ante cualquier dato fuera de rango. */
export function buildAuraPluRecord(input: AuraPluInput): string {
  const { plu, name, type, priceRaw } = input;
  const code = input.code ?? plu;
  const tare = input.tareGrams ?? 0;
  const days = input.validityDays ?? 0;
  if (!Number.isInteger(plu) || plu < 1 || plu > 9999) throw new Error(`PLU fuera de rango (1 a 9999): ${plu}`);
  if (!Number.isInteger(code) || code < 0 || code > 99999) throw new Error(`Código fuera de rango (5 dígitos): ${code}`);
  if (!Number.isInteger(priceRaw) || priceRaw < 0 || priceRaw > 999999) throw new Error(`Precio fuera de rango (6 dígitos): ${priceRaw}`);
  if (!Number.isInteger(tare) || tare < 0 || tare > 9999) throw new Error(`Tara fuera de rango: ${tare}`);
  if (!Number.isInteger(days) || days < 0 || days > 250) throw new Error(`Validez fuera de rango (0 a 250 días): ${days}`);
  if (!["P", "N", "D", "C"].includes(type)) throw new Error(`Tipo desconocido: ${type}`);
  const cleanName = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 .,%/-]/g, " ")
    .slice(0, 16)
    .padEnd(16, " ");
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const record = `${pad(plu, 6)}${cleanName}${type}${pad(code, 5)}0${pad(priceRaw, 6)}${pad(tare, 4)}${pad(days, 3)}`;
  if (record.length !== AURA_PLU_RECORD_LENGTH) throw new Error(`Registro de ${record.length} caracteres (se esperaban ${AURA_PLU_RECORD_LENGTH})`);
  return record;
}
