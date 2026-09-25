import { supabase } from "../../lib/supabase";
import { DEFAULT_SCALE_CONFIG, type ScaleConfig, type ScalePayloadType } from "./scale-barcode";

export * from "./scale-barcode";

interface ScaleConfigRow {
  prefix_length: number;
  plu_length: number;
  weight_length: number;
  weight_divisor: number;
  total_length: number;
  payload_type: ScalePayloadType;
}

function mapConfig(row: ScaleConfigRow): ScaleConfig {
  return {
    prefixLength: row.prefix_length,
    pluLength: row.plu_length,
    weightLength: row.weight_length,
    weightDivisor: Number(row.weight_divisor),
    totalLength: row.total_length,
    payloadType: row.payload_type
  };
}

export async function getBranchScaleConfig(branchId: string): Promise<ScaleConfig | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("branch_scale_configs")
    .select("prefix_length,plu_length,weight_length,weight_divisor,total_length,payload_type")
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
    p_total_length: config.totalLength,
    p_payload_type: config.payloadType
  });

  if (error) throw error;
}

export async function deleteBranchScaleConfig(branchId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_branch_scale_config", { p_branch_id: branchId });
  if (error) throw error;
}
