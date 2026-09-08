import { supabase } from "../../lib/supabase";

export interface ScaleConfig {
  prefixLength: number;
  pluLength: number;
  weightLength: number;
  weightDivisor: number;
  totalLength: number;
}

/** Formato Kretz más común (el único que el sistema entendía antes de
 * poder calibrar): prefijo "2" (1 dígito) + PLU de 5 dígitos + peso en
 * gramos de 5 dígitos + 1 dígito verificador = 13 dígitos (EAN-13). Se usa
 * como valor por defecto para no romper a quien ya lo tenía andando. */
export const DEFAULT_SCALE_CONFIG: ScaleConfig = {
  prefixLength: 1,
  pluLength: 5,
  weightLength: 5,
  weightDivisor: 1000,
  totalLength: 13
};

interface ScaleConfigRow {
  prefix_length: number;
  plu_length: number;
  weight_length: number;
  weight_divisor: number;
  total_length: number;
}

function mapConfig(row: ScaleConfigRow): ScaleConfig {
  return {
    prefixLength: row.prefix_length,
    pluLength: row.plu_length,
    weightLength: row.weight_length,
    weightDivisor: Number(row.weight_divisor),
    totalLength: row.total_length
  };
}

export async function getBranchScaleConfig(branchId: string): Promise<ScaleConfig | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("branch_scale_configs")
    .select("prefix_length,plu_length,weight_length,weight_divisor,total_length")
    .eq("branch_id", branchId)
    .maybeSingle();

  if (error) throw error;
  return data ? mapConfig(data) : null;
}

export async function saveBranchScaleConfig(branchId: string, config: ScaleConfig): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("save_branch_scale_config", {
    p_branch_id: branchId,
    p_prefix_length: config.prefixLength,
    p_plu_length: config.pluLength,
    p_weight_length: config.weightLength,
    p_weight_divisor: config.weightDivisor,
    p_total_length: config.totalLength
  });

  if (error) throw error;
}

export async function deleteBranchScaleConfig(branchId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_branch_scale_config", { p_branch_id: branchId });
  if (error) throw error;
}

/**
 * Lee un código de barras de balanza (EAN-13 típico: prefijo + PLU + peso o
 * importe + dígito verificador) usando la configuración ya calibrada de la
 * sucursal, o el formato Kretz por defecto si todavía no se calibró nada.
 */
export function parseWeightBarcode(code: string, config: ScaleConfig = DEFAULT_SCALE_CONFIG): { plu: string; weightKg: number } | null {
  if (!/^\d+$/.test(code) || code.length !== config.totalLength) return null;

  const pluStart = config.prefixLength;
  const pluEnd = pluStart + config.pluLength;
  const weightStart = pluEnd;
  const weightEnd = weightStart + config.weightLength;
  if (weightEnd > code.length) return null;

  const plu = String(parseInt(code.slice(pluStart, pluEnd), 10));
  const weightRaw = parseInt(code.slice(weightStart, weightEnd), 10);
  if (!Number.isFinite(weightRaw) || weightRaw <= 0) return null;

  return { plu, weightKg: weightRaw / config.weightDivisor };
}

/**
 * Asistente de calibración: el carnicero escanea una etiqueta de SU
 * balanza y dice qué peso mostraba -- se prueban las combinaciones de
 * formato más comunes (largo de prefijo, largo de PLU, largo de peso,
 * gramos/kg) hasta encontrar una que reproduzca ese peso exacto. Devuelve
 * la primera que matchea (orden de prioridad: variantes tipo Kretz
 * primero, que son las más comunes en carnicerías argentinas).
 */
export function detectScaleConfig(code: string, knownWeightKg: number): ScaleConfig | null {
  if (!/^\d+$/.test(code) || code.length < 8) return null;
  const total = code.length;
  const TOLERANCE_KG = 0.001;

  const candidates: ScaleConfig[] = [];
  for (const prefixLength of [1, 2, 0]) {
    for (const pluLength of [5, 4, 6, 3]) {
      // Se reserva 1 dígito verificador al final -- combinación estándar EAN.
      const weightLength = total - prefixLength - pluLength - 1;
      if (weightLength < 3 || weightLength > 6) continue;
      for (const weightDivisor of [1000, 100, 1]) {
        candidates.push({ prefixLength, pluLength, weightLength, weightDivisor, totalLength: total });
      }
    }
  }

  for (const candidate of candidates) {
    const result = parseWeightBarcode(code, candidate);
    if (result && Math.abs(result.weightKg - knownWeightKg) < TOLERANCE_KG) {
      return candidate;
    }
  }

  return null;
}
