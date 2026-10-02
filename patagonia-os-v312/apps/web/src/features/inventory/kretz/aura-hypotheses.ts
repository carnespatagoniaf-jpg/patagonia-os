/**
 * Simulador de hipótesis sobre cómo la Kretz Aura procesa el comando 2005
 * (alta/modificación de PLU) en las posiciones 22-28 del registro de 42
 * caracteres (letra de tipo y código). No se usa en la app: sirve para
 * contrastar cada hipótesis con lo que la balanza real hizo (2 pruebas,
 * 5 escrituras, 2026-10-02) sin tocar la balanza.
 *
 * Evidencia (aura-real-frames.test.ts):
 * - 5005 real de los 6 productos de la clienta: letra P/N/P/D/C/D, código = PLU·10.
 * - 2005 con P/C/N/D y código 990/97/98/96/500 → guardó SIEMPRE "D" y "000000";
 *   nombre, precio, tara y validez quedaron tal cual. La balanza contestó 01
 *   (no 11 "error de modelo de datos"), así que el largo de 42 es el que espera.
 * - Documento público "Multiprotocolo Report Nx" (Kretz, R30 jun-2023), §4.85:
 *   5005 devuelve "los campos y longitudes que se detallan en el comando 2005",
 *   o sea que lectura y escritura usan el MISMO orden. En 2005 el orden es
 *   … Nombre, Descripción, Código del PLU (5), Tipo (1: P, N o R) …, y cada
 *   campo puede tener otro largo según el "modelo de datos" del equipo.
 * - Manual Aura Eco (§8.2.2): la carga a mano pide NOMB (16), CODI (hasta 6),
 *   PESA (Sí/No), PREC (6), TARA (4), VALI (0-250) = 36 + PLU (6) = 42.
 */

export interface WriteObservation {
  sent: string;
  stored: string;
}

export interface Hypothesis {
  id: string;
  description: string;
  /** Qué guardaría la balanza si la hipótesis fuera cierta. */
  store: (sent: string) => string;
  /** Si la hipótesis es cierta, cómo habría que mandar un producto por unidad con código 97 (o null si no hay forma). */
  unitProductWith97?: (base: string) => string | null;
}

const head = (s: string) => s.slice(0, 22);
const tail = (s: string) => s.slice(29);
const pad = (n: number, w: number) => String(n).padStart(w, "0");

export const HYPOTHESES: Hypothesis[] = [
  {
    id: "H0-directa",
    description: "La balanza guarda la letra y el código tal como vienen, en el mismo orden que devuelve 5005.",
    store: (s) => s,
    unitProductWith97: (b) => `${head(b)}N${pad(97, 5)}0${tail(b)}`
  },
  {
    id: "H1-validez",
    description: "La letra la calcula la balanza a partir de pesable y días de validez (P/N con validez, D/C sin validez).",
    store: (s) => {
      const days = Number(s.slice(39, 42));
      const weighable = s[22] === "P" || s[22] === "D";
      const letter = weighable ? (days > 0 ? "P" : "D") : days > 0 ? "N" : "C";
      return `${head(s)}${letter}${s.slice(23, 29)}${tail(s)}`;
    }
  },
  {
    id: "H2-orden-nx",
    description:
      "Al escribir, la balanza lee esas posiciones en el orden del documento Report Nx (código de 5 y después tipo); lo que no es válido queda en su valor por defecto (D y 0).",
    store: (s) => {
      const code = s.slice(22, 27);
      const type = s[27];
      const validCode = /^\d{5}$/.test(code);
      const validType = type === "P" || type === "N";
      return `${head(s)}${validType ? type : "D"}${validCode ? code : "00000"}0${tail(s)}`;
    },
    unitProductWith97: (b) => `${head(b)}${pad(97, 5)}N0${tail(b)}`
  },
  {
    id: "H3-ignora",
    description: "La Aura no toma la letra ni el código por 2005: siempre pone sus valores por defecto (D y 0). Solo se pueden cambiar en la balanza o por otra vía.",
    store: (s) => `${head(s)}D000000${tail(s)}`,
    unitProductWith97: () => null
  },
  {
    id: "H4-letra-deriva-del-codigo",
    description: "La letra la calcula la balanza según tenga código o no (P/N con código, D/C sin código), y el código no se acepta por 2005.",
    store: (s) => `${head(s)}${s[22] === "N" || s[22] === "C" ? "C" : "D"}000000${tail(s)}`
  }
];

/** Devuelve, para cada hipótesis, si explica TODAS las observaciones y cuáles no. */
export function evaluateHypotheses(observations: WriteObservation[], hypotheses = HYPOTHESES) {
  return hypotheses.map((h) => {
    const misses = observations.filter((o) => h.store(o.sent) !== o.stored);
    return { id: h.id, consistent: misses.length === 0, misses: misses.length };
  });
}
