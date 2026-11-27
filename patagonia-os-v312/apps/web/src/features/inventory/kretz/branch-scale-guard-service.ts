import type { ScaleConfig } from "../../sale/scale-barcode";
import { getBranchScaleConfig, saveBranchScaleConfig } from "../../sale/scale-config-service";
import { listBranchScales } from "../../scales/registry/branch-scales";
import { submitScaleSupportReport } from "../../scales/support-service";
import { BRANCH_CONFIG_PROTECTED, branchConfigSupport, mayWriteBranchScaleConfig, type BranchScaleRef } from "./branch-scale-guard";

/** Las balanzas registradas de la sucursal, como las necesita el resguardo C1. */
export async function listBranchScaleRefs(branchId: string): Promise<BranchScaleRef[]> {
  return (await listBranchScales(branchId)).map((s) => ({ key: s.key, active: s.active }));
}

/**
 * Guarda el formato de etiqueta de la sucursal con el resguardo C1 (branch-scale-guard.ts): si el local tiene otra
 * balanza activa y el formato cambiaría, no lo guarda y le manda el detalle a soporte. Para el panel "Balanza por
 * cable" y la calibración de Mostrador (las sincronizaciones de Mi balanza lo hacen en adapters/kretz.ts).
 */
export async function saveBranchScaleConfigGuarded(
  branchId: string,
  next: ScaleConfig,
  currentKey: string | null = null
): Promise<{ saved: true } | { saved: false; message: string; support: Record<string, unknown> }> {
  const scales = await listBranchScaleRefs(branchId).catch(() => null);
  let decision = mayWriteBranchScaleConfig({ scales, currentKey, existing: undefined, next });
  let existing: ScaleConfig | null | undefined;
  if (!decision.allowed) {
    existing = await getBranchScaleConfig(branchId).catch(() => undefined);
    decision = mayWriteBranchScaleConfig({ scales, currentKey, existing, next });
  }
  if (decision.allowed) {
    await saveBranchScaleConfig(branchId, next);
    return { saved: true };
  }
  const support = branchConfigSupport(decision, next, existing, scales);
  try {
    await submitScaleSupportReport({ note: `formato_sucursal_protegido: ${decision.reason}`, logText: JSON.stringify(support), connections: [], branchId });
  } catch {
    // sin conexión o sin permiso: el aviso en pantalla dice igual qué pasó
  }
  return { saved: false, message: BRANCH_CONFIG_PROTECTED, support };
}
