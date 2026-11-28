import { activeLabelProfiles, type LabelSpecRow, type ScaleLabelProfile } from "./label-spec";

/**
 * Copia en ESTA computadora de los perfiles de etiqueta de las balanzas de la sucursal ('balanzas_v2'), para que
 * Mostrador lea etiquetas sin conexión (igual que scale-config-cache.ts con el formato de la sucursal). Se guardan las
 * filas tal cual vinieron (con el historial y su vigencia): los perfiles anteriores vencen solos aunque no haya red.
 * Sin dependencias de Supabase (label-spec-cache.test.ts).
 */

const key = (branchId: string) => `patagonia-scale-label-specs-${branchId}`;

export type LabelProfilesState = { status: "loading" | "ready" | "unknown"; profiles: ScaleLabelProfile[] };

/** Lo que llegó de la base: se guarda y se usa. */
export function labelProfilesLoaded(branchId: string, rows: LabelSpecRow[], now: Date = new Date()): LabelProfilesState {
  try {
    localStorage.setItem(key(branchId), JSON.stringify({ rows, savedAt: now.toISOString() }));
  } catch {
    // sin almacenamiento: se usa igual
  }
  return { status: "ready", profiles: activeLabelProfiles(rows, now) };
}

/** La última copia de esta computadora, o null si nunca se cargó. */
export function cachedLabelProfiles(branchId: string, now: Date = new Date()): LabelProfilesState | null {
  try {
    const raw = localStorage.getItem(key(branchId));
    if (!raw) return null;
    const { rows } = JSON.parse(raw) as { rows: LabelSpecRow[] };
    if (!Array.isArray(rows)) return null;
    return { status: "ready", profiles: activeLabelProfiles(rows, now) };
  } catch {
    return null;
  }
}

/** Al abrir: la copia si hay; si no, "cargando" (no se leen etiquetas hasta saber qué balanzas hay). */
export function initialLabelProfiles(branchId: string | null): LabelProfilesState {
  return (branchId ? cachedLabelProfiles(branchId) : null) ?? { status: "loading", profiles: [] };
}

/** No se pudo cargar: la copia de esta PC; si no hay, no se leen etiquetas (nunca un formato a ciegas). */
export function labelProfilesOnError(branchId: string): LabelProfilesState {
  return cachedLabelProfiles(branchId) ?? { status: "unknown", profiles: [] };
}
