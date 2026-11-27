import type { ScaleConfig } from "../../sale/scale-barcode";

/**
 * C1 (auditoría balanzas v2): el formato de etiqueta que lee Mostrador es UNO por sucursal (branch_scale_configs).
 * Cada envío a una Kretz lo reescribía sin mirar si el local tenía otra balanza, y Mostrador pasaba a leer mal las
 * etiquetas de la otra (real El Abastero 24/11: Report LT + Aura). Resguardo general, sin listas de clientes:
 * - se puede guardar si la sucursal tiene UNA sola balanza activa registrada (la que se está configurando);
 * - se puede guardar si el formato nuevo es IGUAL al guardado (no cambia nada);
 * - si hay otra balanza activa y el formato cambiaría, NO se guarda (va a soporte).
 * Sin datos (no se pudo leer la lista de balanzas, o el formato guardado cuando hace falta compararlo) tampoco se
 * guarda: ante la duda, Mostrador sigue leyendo como hasta ahora.
 */

export interface BranchScaleRef {
  key: string;
  active: boolean;
}

export type BranchConfigDecision =
  | { allowed: true; reason: "una_balanza" | "mismo_formato" }
  | { allowed: false; reason: "otra_balanza" | "sin_datos" };

/** Los dos formatos leen igual (auraPrefix22 es solo del navegador, no se guarda). */
export function sameScaleConfig(a: ScaleConfig, b: ScaleConfig): boolean {
  return (
    a.prefixLength === b.prefixLength &&
    a.pluLength === b.pluLength &&
    a.weightLength === b.weightLength &&
    a.weightDivisor === b.weightDivisor &&
    a.totalLength === b.totalLength &&
    a.payloadType === b.payloadType
  );
}

/**
 * ¿Se puede guardar `next` como formato de la sucursal?
 * - `scales`: las balanzas registradas de la sucursal (null = no se pudo saber).
 * - `currentKey`: la balanza que se está configurando (si no está en la lista, cuenta como una más).
 * - `existing`: el formato guardado hoy (null = ninguno; undefined = no se pudo leer).
 */
export function mayWriteBranchScaleConfig(input: {
  scales: BranchScaleRef[] | null;
  currentKey?: string | null;
  existing: ScaleConfig | null | undefined;
  next: ScaleConfig;
}): BranchConfigDecision {
  const { scales, currentKey, existing, next } = input;
  if (existing && sameScaleConfig(existing, next)) return { allowed: true, reason: "mismo_formato" };
  if (!scales) return { allowed: false, reason: "sin_datos" };
  const active = scales.filter((s) => s.active);
  const keys = new Set(active.map((s) => s.key));
  const count = keys.size + (currentKey && !keys.has(currentKey) ? 1 : 0);
  if (count <= 1) return { allowed: true, reason: "una_balanza" };
  return { allowed: false, reason: "otra_balanza" };
}

/** Lo que ve el cliente cuando el formato no se cambió por tener más de una balanza. */
export const BRANCH_CONFIG_PROTECTED = "Este local tiene más de una balanza: el formato de etiqueta no se cambió. Avisamos a soporte.";

/** Dato de soporte que acompaña al aviso (etapa fija, para encontrarlo en los reportes). */
export function branchConfigSupport(decision: BranchConfigDecision, next: ScaleConfig, existing: ScaleConfig | null | undefined, scales: BranchScaleRef[] | null) {
  return { etapa: "formato_sucursal_protegido", motivo: decision.reason, formato_nuevo: next, formato_guardado: existing ?? null, balanzas_activas: scales ? scales.filter((s) => s.active).map((s) => s.key) : null };
}
