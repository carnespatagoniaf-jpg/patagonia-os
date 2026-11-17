// Etiquetas de cajas envasadas al vacío (las imprime el frigorífico o la planta, no la balanza del local).
// Lógica pura, sin Supabase ni navegador (ver box-label.test.ts).
//
// REAL (Carplat S.A., 16-17/11/2026): EAN-13 = número de caja del producto (2) + 6 números que CAMBIAN con la fecha
// ("110127" el 12/11, "050127" el 06/11: no se usan) + peso en centésimas de kg (4) + verificador.
//   0711012717328 → caja 07 (Roast beef), 17,32 kg
//   1511012722327 → caja 15 (Tortuguita), 22,32 kg
//   0105012721704 → caja 01 (Matambre), 21,70 kg
// El lector manda con 12 números las que empiezan con 0 (como UPC-A, sin ese 0): se repone.
// El número de caja no es el código del producto en Patagonia (Carplat usa 219, 215…): cada formato guarda a qué
// producto corresponde cada número (productMap).

import type { Product } from "@patagonia/domain";

export interface BoxLabelFormat {
  id: string;
  name: string;
  /** Largo del código con el 0 inicial repuesto (13 en un EAN-13). */
  totalLength: number;
  productStart: number;
  productLength: number;
  /** Números que tienen que repetirse en todas las cajas (vacío = ninguno, lo normal: en Carplat cambian con la fecha). */
  fixedStart: number;
  fixedText: string;
  weightStart: number;
  weightLength: number;
  /** 100 = el peso viene en centésimas de kg (1732 = 17,32 kg); 1000 = en gramos. */
  weightDivisor: number;
  /** Número de caja (tal como viene, ej. "07") → id del producto de Patagonia. */
  productMap?: Record<string, string>;
}

export function validEan13(code: string): boolean {
  if (!/^[0-9]{13}$/.test(code)) return false;
  const d = code.split("").map(Number);
  const sum = d.slice(0, 12).reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === d[12];
}

/**
 * El código como lo imprimió el frigorífico. Muchos lectores mandan un EAN-13 que empieza con 0 como UPC-A de 12
 * números (sin ese 0): si con el 0 adelante es un EAN-13 válido, se repone.
 */
export function restoreLeadingZero(raw: string): string {
  const code = raw.trim();
  if (/^[0-9]{12}$/.test(code) && validEan13(`0${code}`)) return `0${code}`;
  return code;
}

export interface BoxLabelRead {
  format: BoxLabelFormat;
  /** Los números del producto tal como vienen en la etiqueta (ej. "07"). */
  productDigits: string;
  weightKg: number;
  /** El código completo, con el 0 repuesto si hacía falta. */
  code: string;
}

/** Lee el código con un formato. null si no tiene esa forma (largo, números fijos, verificador o peso). */
export function readWithFormat(raw: string, format: BoxLabelFormat): BoxLabelRead | null {
  let code = raw.trim();
  if (format.totalLength === 13) code = restoreLeadingZero(code);
  if (!/^[0-9]+$/.test(code) || code.length !== format.totalLength) return null;
  if (code.length === 13 && !validEan13(code)) return null;
  if (format.fixedText && code.slice(format.fixedStart, format.fixedStart + format.fixedText.length) !== format.fixedText) return null;
  const productDigits = code.slice(format.productStart, format.productStart + format.productLength);
  if (productDigits.length !== format.productLength) return null;
  const weightRaw = code.slice(format.weightStart, format.weightStart + format.weightLength);
  if (weightRaw.length !== format.weightLength) return null;
  const weightKg = parseInt(weightRaw, 10) / format.weightDivisor;
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  return { format, productDigits, weightKg, code };
}

/**
 * El producto de esa caja: el asociado a su número en el formato ("07" o "7" es lo mismo). Si el formato tiene cajas
 * asociadas, SOLO esas: una caja sin asociar no entra (REAL Carplat 17/11: la caja 01 de matambre caía en su producto
 * de código "1", MATAMBRE por caja a $16.900, y se cobraba 1 caja de 21,70 kg). Sin ninguna asociada, por código
 * (exacto "07" o sin ceros "7"). Solo activos.
 */
export function productForDigits(digits: string, products: Product[], productMap: Record<string, string> = {}): Product | undefined {
  const active = products.filter((p) => p.active ?? true);
  const mappedId = productMap[digits] ?? Object.entries(productMap).find(([k]) => parseInt(k, 10) === parseInt(digits, 10))?.[1];
  if (mappedId) return active.find((p) => p.id === mappedId);
  if (Object.keys(productMap).length > 0) return undefined;
  const exact = active.find((p) => p.code === digits);
  if (exact) return exact;
  const trimmed = String(parseInt(digits, 10));
  return active.find((p) => p.code === trimmed);
}

export interface BoxScan {
  product: Product;
  quantity: number;
  weightKg: number;
  code: string;
  digits: string;
  detail: string;
}

const kg = (n: number) => `${n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 3 })} kg`;

/** La primera lectura que da con algún formato (aunque su número de caja no tenga producto todavía). */
export function readAnyBox(raw: string, formats: BoxLabelFormat[]): BoxLabelRead | null {
  for (const format of formats) {
    const read = readWithFormat(raw, format);
    if (read) return read;
  }
  return null;
}

/**
 * ¿Es la caja de un producto? Solo si su número tiene producto (asociado o por código) y el producto tiene precio: si
 * no, null y Mostrador sigue como siempre (puede ser una etiqueta de balanza u otro código). Por kg entra con los kilos
 * de la caja; por unidad o por caja, como 1.
 */
export function resolveBoxScan(raw: string, formats: BoxLabelFormat[], products: Product[]): BoxScan | null {
  for (const format of formats) {
    const read = readWithFormat(raw, format);
    if (!read) continue;
    const product = productForDigits(read.productDigits, products, format.productMap);
    if (!product || !(product.priceRetail > 0)) continue;
    const quantity = product.unit === "kg" ? Math.round(read.weightKg * 1000) / 1000 : 1;
    const what = product.unit === "kg" ? kg(quantity) : `1 ${product.unit === "box" ? "caja" : "u."} (${kg(read.weightKg)})`;
    return { product, quantity, weightKg: read.weightKg, code: read.code, digits: read.productDigits, detail: `${product.name}: ${what} (caja)` };
  }
  return null;
}

/** Por qué una caja no entró (aviso de Mostrador y botón Probar). null si no tiene forma de caja. */
export function boxProblem(raw: string, formats: BoxLabelFormat[], products: Product[]): string | null {
  for (const format of formats) {
    const read = readWithFormat(raw, format);
    if (!read) continue;
    const product = productForDigits(read.productDigits, products, format.productMap);
    if (!product) {
      return `Es una caja de "${format.name}" con el número ${read.productDigits} y ${kg(read.weightKg)}, pero ese número todavía no tiene un producto de Patagonia. No se agregó nada: en el engranaje de Mostrador → Etiquetas de cajas, tocá "Asociar", escaneá la caja y elegí el producto.`;
    }
    if (!(product.priceRetail > 0)) {
      return `${product.name} no tiene precio cargado en Patagonia, así que se cobraría $0. No se agregó nada: cargale el precio en Stock y volvé a escanear.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Aprender el formato con dos cajas de productos distintos y los kilos que dice cada una.

export interface BoxSample {
  code: string;
  kg: number;
}

export type LearnResult =
  | { ok: true; format: Omit<BoxLabelFormat, "id" | "name"> }
  | { ok: false; reason: string };

const DIVISORS = [100, 1000, 10];

/**
 * Busca dónde está el peso (el mismo lugar en las dos etiquetas da los kilos de cada una). Lo de adelante: los números
 * iguales en las dos, pegados al peso, son de la fecha o el lote (no se exigen); el resto es el número de producto. Si
 * dos productos terminan igual (07 y 17) se come ese número: la pantalla deja correr el corte.
 */
export function learnBoxLabelFormat(samples: BoxSample[]): LearnResult {
  if (samples.length < 2) return { ok: false, reason: "Hacen falta dos cajas." };
  const codes = samples.map((s) => restoreLeadingZero(s.code));
  if (codes.some((c) => !/^[0-9]{8,20}$/.test(c))) return { ok: false, reason: "El código tiene que ser solo números (entre 8 y 20)." };
  const total = codes[0].length;
  if (codes.some((c) => c.length !== total)) return { ok: false, reason: "Las dos etiquetas tienen largos distintos: no son del mismo frigorífico o una se leyó mal." };
  if (new Set(codes).size < codes.length) return { ok: false, reason: "Escaneaste dos veces la misma caja." };
  if (samples.some((s) => !(s.kg > 0))) return { ok: false, reason: "Escribí los kilos de cada caja." };

  // El peso: preferir que termine justo antes del verificador.
  type Cand = { start: number; length: number; divisor: number; trailing: number };
  const cands: Cand[] = [];
  for (let length = 3; length <= 6; length++) {
    for (let start = 1; start + length <= total; start++) {
      for (const divisor of DIVISORS) {
        const fits = codes.every((c, i) => Math.abs(parseInt(c.slice(start, start + length), 10) / divisor - samples[i].kg) < 0.0005);
        if (fits) cands.push({ start, length, divisor, trailing: total - (start + length) });
      }
    }
  }
  cands.sort((a, b) => Math.abs(a.trailing - 1) - Math.abs(b.trailing - 1) || b.length - a.length);
  const weight = cands[0];
  if (!weight) {
    return { ok: false, reason: "No se encontraron los kilos en el código. Revisá que escribiste el PESO NETO de cada caja tal como dice la etiqueta." };
  }

  const before = codes.map((c) => c.slice(0, weight.start));
  let sameLength = 0;
  while (sameLength < weight.start && before.every((b) => b[weight.start - 1 - sameLength] === before[0][weight.start - 1 - sameLength])) sameLength++;
  // Con cajas de días distintos los números de la fecha también difieren y el producto sale más largo: por eso la
  // pantalla pide dos cajas del mismo día, y se corrige con "Uno menos".
  const productLength = weight.start - sameLength;
  if (productLength < 1) return { ok: false, reason: "Las dos etiquetas tienen el mismo producto. Escaneá dos cajas de productos distintos." };

  return {
    ok: true,
    format: {
      totalLength: total,
      productStart: 0,
      productLength,
      // Los números entre el producto y el peso NO se exigen: en Carplat cambian con la fecha de producción.
      fixedStart: productLength,
      fixedText: "",
      weightStart: weight.start,
      weightLength: weight.length,
      weightDivisor: weight.divisor
    }
  };
}

/** Correr el corte del número de producto (+1 = un número más para el producto). */
export function shiftProductCut(format: Omit<BoxLabelFormat, "id" | "name">, delta: number): Omit<BoxLabelFormat, "id" | "name"> | null {
  const productLength = format.productLength + delta;
  if (productLength < 1 || productLength > format.weightStart) return null;
  return { ...format, productLength, fixedStart: productLength, fixedText: "" };
}
