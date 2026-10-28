/**
 * Qué puede hacer Patagonia con cada balanza, y CON QUÉ se sabe.
 *
 * Regla de producto: "Mi balanza" solo escribe en la balanza lo que está COMPROBADO CON UNA BALANZA REAL
 * (`evidence: "real"`). Lo simulado o documentado sirve para leer, nunca para escribir. Agregar una marca =
 * un adaptador nuevo en `adapters/` + una entrada acá; la pantalla no cambia.
 *
 * Fuentes: docs/BALANZAS_KRETZ.md, docs/SYSTEL_INFORME.md, CLAUDE.md (secciones de balanzas).
 */

import type { ModelLimits } from "./preflight";

export type Evidence = "real" | "simulado" | "no";

export type ScaleModelId = "kretz-report-lt" | "kretz-aura" | "kretz-otra" | "systel-cuora-max" | "systel-otra";

export interface ScaleCapabilities {
  /** Nombre comercial que ve el cliente. */
  label: string;
  /** Leer los productos que tiene la balanza. */
  readProducts: Evidence;
  /** Mandar productos y precios desde Patagonia. */
  sendProducts: Evidence;
  /** Dejar que cada producto imprima su código de barras (producto + kilos o unidades) en el ticket. */
  itemBarcodes: Evidence;
  /** Releer después de escribir y comparar campo por campo. */
  verifyAfterWrite: Evidence;
  /** Mostrador lee los tickets impresos (producto, kilos/unidades, TOTAL) y descuenta stock. */
  ticketSale: Evidence;
  /** De dónde sale cada "real". */
  sources: string[];
}

export const SCALE_CAPABILITIES: Record<ScaleModelId, ScaleCapabilities> = {
  "kretz-report-lt": {
    label: "Kretz Report",
    readProducts: "real",
    sendProducts: "real",
    itemBarcodes: "no",
    verifyAfterWrite: "real",
    ticketSale: "real",
    sources: ["Report LT de Carnes Patagonia (sept. 2026): alta 2005 + relectura 5005 campo por campo"]
  },
  "kretz-aura": {
    label: "Kretz Aura",
    readProducts: "real",
    sendProducts: "real",
    // El ticket con varios productos trae SOLO el código del TOTAL (manual Aura Eco §7.1.7) y la Aura de Pollo y mar
    // rechazó el 1080 (respuesta 02). Código por producto = modo Pre-Empaque (ALT + 7, §12.5): un ticket por producto.
    itemBarcodes: "no",
    verifyAfterWrite: "real",
    ticketSale: "real",
    sources: [
      "Pollo y mar 05/10/2026: 223 productos mandados, cada uno releído; los demás sin cambios",
      "Pollo y mar 15/10/2026: código por producto en el ticket de suma (1080) RECHAZADO (respuesta 02)",
      "Manual Aura Eco Rev.01 §7.1.7 y §12.5: formatos pesable / unitario / suma; Pre-Empaque imprime un ticket por producto"
    ]
  },
  "kretz-otra": {
    label: "Balanza Kretz",
    readProducts: "simulado",
    sendProducts: "no",
    itemBarcodes: "no",
    verifyAfterWrite: "no",
    ticketSale: "no",
    sources: ["Modelo no probado: solo se lee, nunca se escribe"]
  },
  "systel-cuora-max": {
    label: "Systel Cuora Max",
    readProducts: "real",
    // Patagonia → balanza con la función 61 (producto completo). Comprobado en Los gringos (14/10): crear productos con
    // nombre, precio y forma de venta (7999 a 7995) y reescribir el registro completo de 103 productos, cada uno releído.
    // Habilitado el 19/10 (pedido del dueño, balanza nueva de Los gringos). NO comprobado: si al cambiarle precio o nombre
    // a un producto que ya existe la balanza conserva SUS totales de venta; Mis balanzas lo avisa antes de sincronizar.
    // Cada escritura se relee antes y después, y ante una diferencia se restaura lo que había (systel-push.ts).
    sendProducts: "real",
    itemBarcodes: "real",
    verifyAfterWrite: "real",
    ticketSale: "real",
    sources: [
      "Los gringos 14/10/2026: 103 productos con su código propio (función 61), cada uno releído; ventas y demás datos iguales",
      "Los gringos 14/10/2026: productos de prueba creados con nombre, precio y forma de venta, releídos iguales",
      "Habilitado 19/10/2026 para pasar productos a la segunda balanza de Los gringos; falta comprobar los totales de la balanza al cambiar un producto existente",
      "Ticket real: 2179950000014 (7995 × 1 u), 2000130002101 (13, 0,210 kg), TOTAL 2202000019336"
    ]
  },
  "systel-otra": {
    label: "Balanza Systel",
    readProducts: "simulado",
    sendProducts: "no",
    itemBarcodes: "no",
    verifyAfterWrite: "no",
    ticketSale: "simulado",
    sources: ["Firma o formato distinto al de la Cuora Max comprobada: solo se lee"]
  }
};

/** Puede escribir esta función en la balanza (solo lo comprobado en una real). */
export function canWrite(model: ScaleModelId, what: "sendProducts" | "itemBarcodes"): boolean {
  return SCALE_CAPABILITIES[model][what] === "real";
}

/**
 * Límites de cada modelo para la revisión previa (preflight.ts). Un solo lugar por modelo: el envío, la revisión y la
 * pantalla leen de acá. Las Systel completan los límites con lo que informa cada balanza (layout, decimales, formato
 * de etiqueta), ver `systelLimits`.
 */

/** Etiqueta 2-3-7 que Patagonia les configura a las Kretz (1070 "2002005"): el producto va en 3 cifras. */
export const KRETZ_LABEL_MAX_CODE = 999;

export const MODEL_LIMITS: Partial<Record<ScaleModelId, ModelLimits>> = {
  // Campo "Código de PLU" de 5 cifras (5002), precio de 6 en pesos enteros, nombre de 26.
  "kretz-report-lt": { maxCode: 99999, labelMaxCode: KRETZ_LABEL_MAX_CODE, priceDecimals: 0, maxPriceRaw: 999999, nameLength: 26 },
  // PLU hasta 9999, tipo D/C en pesos enteros, nombre de 16 (Pollo y mar, real).
  "kretz-aura": { maxCode: 9999, labelMaxCode: KRETZ_LABEL_MAX_CODE, priceDecimals: 0, maxPriceRaw: 999999, nameLength: 16 }
};

/** Límites de una Systel según lo que leyó de la balanza. */
export function systelLimits(info: { maxPlu: number; maxCode: number }, priceDecimals: number, labelFormats: (string | null | undefined)[]): ModelLimits {
  const label = labelFormats.map((f) => (f && /P+/.exec(f) ? Math.pow(10, /P+/.exec(f)![0].length) - 1 : null)).filter((x): x is number => x !== null);
  return {
    maxCode: Math.min(info.maxPlu, info.maxCode),
    labelMaxCode: label.length ? Math.min(...label) : null,
    priceDecimals: priceDecimals === 2 ? 2 : 0,
    maxPriceRaw: 999999,
    nameLength: 18
  };
}
