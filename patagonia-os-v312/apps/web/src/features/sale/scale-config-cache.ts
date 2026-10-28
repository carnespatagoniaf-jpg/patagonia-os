import { DEFAULT_SCALE_CONFIG, type ScaleConfig } from "./scale-barcode";

/**
 * Formato de etiquetas de la sucursal guardado en esta computadora, para que Mostrador nunca lea etiquetas con un
 * formato equivocado. Antes, si la carga fallaba (sin internet, Mostrador abierto offline) se usaba el formato Kretz de
 * fábrica sin avisar: con una etiqueta 1-6-5 (Carnes Patagonia) eso lee otro producto y otros kilos (auditoría 28/10).
 * Sin dependencias de Supabase, para poder probarlo solo.
 */

const key = (branchId: string) => `patagonia-scale-config-${branchId}`;

/** No lee ninguna etiqueta (largo imposible): solo productos por su código exacto. */
export const SCALE_CONFIG_UNKNOWN: ScaleConfig = { ...DEFAULT_SCALE_CONFIG, totalLength: -1 };

export interface ScaleConfigState {
  config: ScaleConfig;
  /** true = la sucursal tiene un formato calibrado (no el de fábrica). */
  calibrated: boolean;
  /** true = no se sabe el formato: las etiquetas no se leen hasta que vuelva la conexión. */
  unknown: boolean;
}

/** Lo que llegó de la base (null = la sucursal no calibró nada: formato de fábrica, como siempre). */
export function scaleConfigLoaded(branchId: string, config: ScaleConfig | null): ScaleConfigState {
  try {
    localStorage.setItem(key(branchId), JSON.stringify({ config }));
  } catch {
    // sin almacenamiento: se usa igual
  }
  return config ? { config, calibrated: true, unknown: false } : { config: DEFAULT_SCALE_CONFIG, calibrated: false, unknown: false };
}

/** El último formato que se cargó bien en esta computadora, o null si nunca. */
export function cachedScaleConfig(branchId: string): ScaleConfigState | null {
  try {
    const raw = localStorage.getItem(key(branchId));
    if (!raw) return null;
    const { config } = JSON.parse(raw) as { config: ScaleConfig | null };
    if (config && !(config.totalLength > 0 && config.pluLength > 0 && config.weightDivisor > 0)) return null;
    return config ? { config, calibrated: true, unknown: false } : { config: DEFAULT_SCALE_CONFIG, calibrated: false, unknown: false };
  } catch {
    return null;
  }
}

/** No se pudo cargar: el último conocido en esta computadora; si no hay, no se leen etiquetas (nunca el de fábrica a ciegas). */
export function scaleConfigOnError(branchId: string): ScaleConfigState {
  return cachedScaleConfig(branchId) ?? { config: SCALE_CONFIG_UNKNOWN, calibrated: false, unknown: true };
}

export const SCALE_CONFIG_UNKNOWN_MESSAGE =
  "No se pudo cargar cómo se leen las etiquetas de la balanza en esta sucursal. Hasta que vuelva la conexión, las etiquetas no se leen: buscá el producto y escribí los kilos del ticket.";
