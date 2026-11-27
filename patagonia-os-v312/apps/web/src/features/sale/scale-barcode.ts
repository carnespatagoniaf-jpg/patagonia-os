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
  /** Solo en el navegador (no se guarda): la sucursal tiene una Aura con inicio "22" además de su formato (AURA_PREFIX_22_BRANCHES). */
  auraPrefix22?: boolean;
  /**
   * Solo en el navegador (sale del perfil de la balanza, scales/label-spec.ts): inicio propio 22-29 de una Kretz con
   * 2-3-7 en centavos. Esas etiquetas se leen como las de la Aura con inicio 22 (producto 998 = TOTAL).
   */
  ownPrefix?: string;
  /** Solo en el navegador: inicio de las etiquetas por UNIDAD de una Systel con inicio propio (si no, "21"). */
  unitPrefix?: string;
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

/**
 * Ticket de SUMA leído con el formato de etiqueta que la sucursal tiene guardado (el que su balanza usa de
 * verdad). REAL El Abastero 21/11/2026: su Kretz imprime 1-6-5 con importe en PESOS enteros ("2 000101 69000 9"
 * = PLU 101, $69.000) y el ticket de suma "2 099998 68932 6" = $68.932,10. parseAuraSumTicket probaba primero el
 * 2-5-5 en centavos de fábrica y lo leía como $689,32. Si el formato guardado es de importe y el código del medio
 * es el de suma (99998 con ceros adelante, o sus últimas cifras: 9998, 998), el importe sale con ESE formato.
 * undefined = no aplica (formato de peso, otro largo, o no es un ticket de suma); amount null = suma sin importe
 * (todo en 0 o todo en 9: el total no entró en el campo).
 */
export function parseSumTicketWithConfig(rawCode: string, config: ScaleConfig): { amount: number | null } | undefined {
  const code = rawCode.trim();
  if (config.payloadType !== "amount" || config.totalLength !== 13) return undefined;
  if (config.prefixLength + config.pluLength + config.weightLength !== 12) return undefined;
  if (!/^2[0-9]{12}$/.test(code)) return undefined;
  const digits = code.split("").map(Number);
  const sum = digits.slice(0, 12).reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  if ((10 - (sum % 10)) % 10 !== digits[12]) return undefined;
  const codePart = code.slice(config.prefixLength, config.prefixLength + config.pluLength).replace(/^0+/, "");
  if (codePart.length < 3 || !"99998".endsWith(codePart)) return undefined;
  const value = code.slice(config.prefixLength + config.pluLength, 12);
  if (/^(0+|9+)$/.test(value)) return { amount: null };
  return { amount: parseInt(value, 10) / config.weightDivisor };
}

/**
 * Ticket de SUMA (total) de una Systel Cuora. REAL, Los gringos, 2026-10-13: su balanza tiene
 * configurado "E_S=22BBIIIIIIII" (leído de la balanza el 2026-10-09). Eso es 22 + número de
 * balanza (2) + importe (8) + verificador. El ticket "TOTAL $780" trae 2220000007801: balanza 00,
 * importe 00000780, en PESOS ENTEROS (esa balanza trabaja sin decimales: firma D0).
 * Ojo: una etiqueta de PLU que empiece con 2 también puede empezar con "22". Por eso quien llama
 * lo prueba DESPUÉS de ver que no es la etiqueta de un producto que existe.
 * Devuelve el importe, o null si no tiene esta forma.
 */
export function parseSystelSumTicket(rawCode: string): number | null {
  const code = rawCode.trim();
  if (!isSystelSumShape(code)) return null;
  if (systelSumWithoutAmount(code)) return null;
  const pesos = parseInt(code.slice(4, 12), 10);
  return pesos > 0 ? pesos : null;
}

function isSystelSumShape(code: string): boolean {
  if (!/^22[0-9]{11}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const sum = digits.slice(0, 12).reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === digits[12];
}

/**
 * Ticket de total de Systel cuyo código NO trae el importe. REAL (cliente TripleS, 2026-10-13):
 * un ticket de TOTAL $12.810 con el código 2211999999994, o sea 22 + "11" + 99999999. Leído como
 * importe daría $99.999.999. Si el campo del importe son todos 9, no es un importe.
 */
export function systelSumWithoutAmount(rawCode: string): boolean {
  const code = rawCode.trim();
  return isSystelSumShape(code) && /^9{8}$/.test(code.slice(4, 12));
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
 * Asistente de calibración: el carnicero escanea una etiqueta de SU balanza y dice qué peso (o importe) mostraba; se
 * prueban las combinaciones de formato más comunes (largo de prefijo, de PLU, del valor, divisor) que reproducen ese
 * valor exacto.
 *
 * C6 (26/11): antes se quedaba con la PRIMERA que coincidía. Con una etiqueta de menos de 10 kg casi siempre coinciden
 * dos que leen productos distintos (ej. "20 00012 01250": producto 12 + 1,250 kg, o producto 120 + 1,250 kg) y guardar
 * la equivocada hace que Mostrador cobre otro producto. Ahora nunca elige con dudas: devuelve null si hay más de una
 * lectura posible. La pantalla de calibración tiene que usar `detectScaleConfigFromSamples` y, ante
 * "need_another_label", pedir el N.º de producto de la etiqueta (askPlu) o una segunda etiqueta (mejor de más de 10 kg).
 */
export function detectScaleConfig(code: string, knownValue: number, payloadType: ScalePayloadType = "weight"): ScaleConfig | null {
  const r = detectScaleConfigFromSamples([{ code, value: knownValue }], payloadType);
  return r.kind === "ok" ? r.config : null;
}

/** Una etiqueta de muestra: el código, el peso (o importe) que mostraba la balanza y, si se sabe, el N.º de producto. */
export interface CalibrationSample {
  code: string;
  value: number;
  plu?: string;
}

export type CalibrationResult =
  | { kind: "ok"; config: ScaleConfig }
  /**
   * Más de una lectura posible: no se guarda nada. `options`: lo que leería cada formato en cada etiqueta (para mostrar
   * "¿es el producto 12 o el 120?"). `askPlu`: las lecturas difieren en el N.º de producto (preguntarlo lo resuelve).
   */
  | { kind: "need_another_label"; askPlu: boolean; options: Array<{ config: ScaleConfig; readings: Array<{ plu: string; value: number }> }> }
  | { kind: "none" };

export function detectScaleConfigFromSamples(samples: CalibrationSample[], payloadType: ScalePayloadType = "weight"): CalibrationResult {
  if (samples.length === 0 || samples.some((s) => !/^\d+$/.test(s.code) || s.code.length < 8)) return { kind: "none" };
  const total = samples[0].code.length;
  if (samples.some((s) => s.code.length !== total)) return { kind: "none" };
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

  // Formatos que leen TODAS las etiquetas con su valor (y su N.º de producto, si se dijo), agrupados por lo que leen:
  // dos formatos que leen lo mismo en todas las muestras (ej. 2-5-5 y 1-6-5 con "20…") no son una duda.
  const groups = new Map<string, { config: ScaleConfig; readings: Array<{ plu: string; value: number }> }>();
  for (const candidate of candidates) {
    const readings: Array<{ plu: string; value: number }> = [];
    for (const s of samples) {
      const result = parseWeightBarcode(s.code, candidate);
      if (!result) break;
      const value = result.kind === "weight" ? result.weightKg : result.amount;
      if (Math.abs(value - s.value) >= TOLERANCE) break;
      if (s.plu !== undefined && String(Number(s.plu)) !== result.plu) break;
      readings.push({ plu: result.plu, value });
    }
    if (readings.length !== samples.length) continue;
    // Mismo producto en cada etiqueta Y mismo campo del valor (dónde empieza, dónde termina, divisor): si no, dos
    // formatos que hoy dan lo mismo leerían distinto otra etiqueta (ej. 1,250 kg en "01250" o en "0125" ÷ 100).
    const valueStart = candidate.prefixLength + candidate.pluLength;
    const key = `${readings.map((r) => r.plu).join("|")}#${valueStart}-${valueStart + candidate.weightLength}/${candidate.weightDivisor}`;
    if (!groups.has(key)) {
      const { trailing: _trailing, ...config } = candidate;
      groups.set(key, { config, readings });
    }
  }
  if (groups.size === 0) return { kind: "none" };
  const options = [...groups.values()];
  if (options.length === 1) return { kind: "ok", config: options[0].config };
  const askPlu = samples.some((s, i) => new Set(options.map((o) => o.readings[i].plu)).size > 1);
  return { kind: "need_another_label", askPlu, options };
}
