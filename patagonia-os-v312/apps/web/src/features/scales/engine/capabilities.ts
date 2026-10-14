/**
 * Qué puede hacer Patagonia con cada balanza, y CON QUÉ se sabe.
 *
 * Regla de producto: "Mi balanza" solo escribe en la balanza lo que está COMPROBADO CON UNA BALANZA REAL
 * (`evidence: "real"`). Lo simulado o documentado sirve para leer, nunca para escribir. Agregar una marca =
 * un adaptador nuevo en `adapters/` + una entrada acá; la pantalla no cambia.
 *
 * Fuentes: docs/BALANZAS_KRETZ.md, docs/SYSTEL_INFORME.md, CLAUDE.md (secciones de balanzas).
 */

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
    itemBarcodes: "simulado",
    verifyAfterWrite: "real",
    ticketSale: "real",
    sources: [
      "Pollo y mar 05/10/2026: 223 productos mandados, cada uno releído; los demás sin cambios",
      "Código por producto (1080): publicado 08/10 sin confirmación de una Aura real"
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
    // Precios por cable (función 33): documentado, sin probar en una balanza real.
    sendProducts: "no",
    itemBarcodes: "real",
    verifyAfterWrite: "real",
    ticketSale: "real",
    sources: [
      "Los gringos 14/10/2026: 103 productos con su código propio (función 61), cada uno releído; ventas y demás datos iguales",
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
