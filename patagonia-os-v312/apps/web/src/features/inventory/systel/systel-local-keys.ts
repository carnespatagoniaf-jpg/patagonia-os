/**
 * Claves de este navegador para lo que se guarda de UNA Systel (respaldos, prueba de escritura). Antes eran globales
 * de la PC: con varias Systel en la misma computadora, la última pisaba a las otras (C24, plan balanzas v2).
 * Ahora van por balanza (`scale_key`); la clave vieja global se sigue leyendo como respaldo para no perder lo guardado.
 */

/** La balanza de antes de la migración 134 (una sola Systel por sucursal): la misma que LEGACY_SYSTEL_KEY. */
export const DEFAULT_SYSTEL_SCALE_KEY = "systel";

export function systelScopedKey(base: string, scaleKey: string | null | undefined): string {
  return `${base}:${scaleKey || DEFAULT_SYSTEL_SCALE_KEY}`;
}

/** Lo guardado para esa balanza; si no hay, lo que quedó en la clave global vieja. */
export function readSystelScoped(base: string, scaleKey: string | null | undefined): string | null {
  try {
    return localStorage.getItem(systelScopedKey(base, scaleKey)) ?? localStorage.getItem(base);
  } catch {
    return null;
  }
}

/** Guarda solo en la clave de esa balanza (la global vieja no se toca: la pueden necesitar las otras). */
export function writeSystelScoped(base: string, scaleKey: string | null | undefined, value: string): boolean {
  try {
    localStorage.setItem(systelScopedKey(base, scaleKey), value);
    return true;
  } catch {
    return false;
  }
}
