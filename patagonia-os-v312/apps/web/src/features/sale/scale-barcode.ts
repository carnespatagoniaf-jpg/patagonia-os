// Lectura de códigos de barras de balanza. Sin dependencias de Supabase ni del
// navegador a propósito: así se puede probar sola (ver scale-barcode.test.ts).

export type ScalePayloadType = "weight" | "amount";

export interface ScaleConfig {
  prefixLength: number;
  pluLength: number;
  weightLength: number;
  weightDivisor: number;
  totalLength: number;
  payloadType: ScalePayloadType;
}

export type ScaleBarcodeResult =
  | { plu: string; kind: "weight"; weightKg: number }
  | { plu: string; kind: "amount"; amount: number };

/** Formato Kretz más común (el único que el sistema entendía antes de
 * poder calibrar): prefijo "2" (1 dígito) + PLU de 5 dígitos + peso en
 * gramos de 5 dígitos + 1 dígito verificador = 13 dígitos (EAN-13). Se usa
 * como valor por defecto para no romper a quien ya lo tenía andando. */
export const DEFAULT_SCALE_CONFIG: ScaleConfig = {
  prefixLength: 1,
  pluLength: 5,
  weightLength: 5,
  weightDivisor: 1000,
  totalLength: 13,
  payloadType: "weight"
};

/**
 * Lee un código de barras de balanza (EAN-13 típico: prefijo + PLU + peso o
 * importe + dígito verificador) usando la configuración ya calibrada de la
 * sucursal, o el formato Kretz por defecto si todavía no se calibró nada.
 * "amount" es para balanzas que graban el importe final en vez del peso
 * (ej. Aura Eco tipo ticket continuo) -- sigue necesitando un PLU en el
 * código para saber de qué producto se trata; un ticket que solo trae un
 * total de varios productos juntos, sin PLU, no se puede leer así (hay que
 * cargarlo a mano, buscando cada producto por nombre en Mostrador).
 */
export function parseWeightBarcode(code: string, config: ScaleConfig = DEFAULT_SCALE_CONFIG): ScaleBarcodeResult | null {
  if (!/^\d+$/.test(code) || code.length !== config.totalLength) return null;

  const pluStart = config.prefixLength;
  const pluEnd = pluStart + config.pluLength;
  const valueStart = pluEnd;
  const valueEnd = valueStart + config.weightLength;
  if (valueEnd > code.length) return null;

  const plu = String(parseInt(code.slice(pluStart, pluEnd), 10));
  const valueRaw = parseInt(code.slice(valueStart, valueEnd), 10);
  if (!Number.isFinite(valueRaw) || valueRaw <= 0) return null;

  if (config.payloadType === "amount") {
    return { plu, kind: "amount", amount: valueRaw / config.weightDivisor };
  }
  return { plu, kind: "weight", weightKg: valueRaw / config.weightDivisor };
}

/**
 * Ticket de TOTAL de balanzas tipo caja (ej. Kretz Aura Eco 2): un solo
 * ticket con varios productos pesados, cuyo código de barras trae el importe
 * final y nada más -- sin PLU ni peso, así que no se puede saber qué
 * productos lo componen. Formato confirmado con un ticket real: EAN-13 =
 * "00000" + importe en centavos (7 dígitos) + dígito verificador. Ej.
 * 0000014550003 = $14.550,00 (el ticket mostraba "TOTAL = 14550.00$").
 * Se exige el dígito verificador EAN-13 válido y los ceros iniciales para no
 * confundirlo con una etiqueta de un solo producto ni con un código común.
 *
 * Solo hay UN ticket real de muestra, con un importe de 5 cifras. Para
 * importes de $100.000 o más se asume que el campo se ensancha a 8 dígitos
 * (4 ceros iniciales) -- no está confirmado, por eso desde
 * TICKET_TOTAL_CONFIRM_FROM el llamador le pide al cajero que verifique el
 * importe contra el TOTAL impreso antes de cargarlo.
 */
export const TICKET_TOTAL_CONFIRM_FROM = 100000;

/**
 * Ticket de SUMA de la Kretz Aura (balanza de la clienta Pollo y mar, REAL 2026-10-05):
 * EAN-13 = inicio "20" (o "2") + código suma (99998, o sus últimas cifras si el campo es
 * más corto) + importe en CENTAVOS + verificador. Formatos del manual (§7.1.7):
 * 2-5-5 (el de fábrica), 2-4-6, 2-3-7, 1-4-7, 1-5-6, 1-6-5. Con 2-5-5 el importe tiene
 * 5 cifras y la balanza pone 00000 si el ticket pasa de $999,99 (real: "2099998000008"
 * en tickets de $2.106 y $63.068; "20 99998 00592" en uno de $5,92). Con 2-3-7 o 1-4-7
 * entran hasta $99.999,99.
 * Devuelve null si no es un ticket de suma; amount null si es de suma pero sin importe.
 */
const AURA_SUM_FORMATS: [number, number, number][] = [[2, 5, 5], [2, 4, 6], [2, 3, 7], [1, 4, 7], [1, 5, 6], [1, 6, 5]];

export function parseAuraSumTicket(rawCode: string): { amount: number | null; format: string } | null {
  const code = rawCode.trim();
  if (!/^2[0-9]{12}$/.test(code)) return null;
  const digits = code.split("").map(Number);
  const sum = digits.slice(0, 12).reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  if ((10 - (sum % 10)) % 10 !== digits[12]) return null;
  for (const [p, c, v] of AURA_SUM_FORMATS) {
    if (code.slice(0, p) !== (p === 2 ? "20" : "2")) continue;
    const codePart = code.slice(p, p + c);
    // El código suma es 99998; si el campo es más corto la balanza puede dejar las últimas o las primeras cifras.
    if (codePart.length < 3 || !("999998".endsWith(codePart) || "99998".startsWith(codePart))) continue;
    const cents = parseInt(code.slice(p + c, p + c + v), 10);
    return { amount: cents > 0 ? cents / 100 : null, format: `${p}-${c}-${v}` };
  }
  return null;
}

export function parseTicketTotalBarcode(rawCode: string): number | null {
  // Muchos lectores devuelven un EAN-13 que empieza en 0 como UPC-A de 12
  // dígitos (sin ese primer cero) -- pasó con un cliente real. Se repone.
  const code = /^[0-9]{12}$/.test(rawCode) ? `0${rawCode}` : rawCode;
  if (!/^[0-9]{13}$/.test(code) || !code.startsWith("0000")) return null;

  const digits = code.split("").map(Number);
  const sum = digits.slice(0, 12).reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  if ((10 - (sum % 10)) % 10 !== digits[12]) return null;

  const cents = parseInt(code.slice(4, 12), 10);
  return cents > 0 ? cents / 100 : null;
}

/**
 * Asistente de calibración: el carnicero escanea una etiqueta de SU
 * balanza y dice qué peso (o importe) mostraba -- se prueban las
 * combinaciones de formato más comunes (largo de prefijo, largo de PLU,
 * largo del valor, divisor) hasta encontrar una que reproduzca ese valor
 * exacto. Devuelve la primera que matchea.
 */
export function detectScaleConfig(code: string, knownValue: number, payloadType: ScalePayloadType = "weight"): ScaleConfig | null {
  if (!/^\d+$/.test(code) || code.length < 8) return null;
  const total = code.length;
  const TOLERANCE = payloadType === "weight" ? 0.001 : 0.01;

  // "trailing" = dígitos que sobran después del valor: 1 es solo el verificador
  // (lo más común); 2 o más es un dígito reservado antes del verificador (el
  // formato Kretz por defecto, 1+5+5 de 13, es así). Se prueban primero los
  // que solo dejan el verificador.
  const candidates: (ScaleConfig & { trailing: number })[] = [];
  for (const prefixLength of [1, 2, 0]) {
    for (const pluLength of [5, 4, 6, 3]) {
      for (const weightLength of [3, 4, 5, 6]) {
        const trailing = total - prefixLength - pluLength - weightLength;
        if (trailing < 1 || trailing > 3) continue;
        for (const weightDivisor of [1000, 100, 1]) {
          candidates.push({ prefixLength, pluLength, weightLength, weightDivisor, totalLength: total, payloadType, trailing });
        }
      }
    }
  }
  candidates.sort((a, b) => a.trailing - b.trailing);

  for (const candidate of candidates) {
    const result = parseWeightBarcode(code, candidate);
    if (!result) continue;
    const value = result.kind === "weight" ? result.weightKg : result.amount;
    if (Math.abs(value - knownValue) < TOLERANCE) {
      const { trailing: _trailing, ...config } = candidate;
      return config;
    }
  }

  return null;
}
