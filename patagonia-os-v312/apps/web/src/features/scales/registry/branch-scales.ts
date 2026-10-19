import { supabase } from "../../../lib/supabase";
import { rowToScale, type BranchScale, type ScaleFamily, type ScaleRow as Row } from "./scale-identity";

export * from "./scale-identity";

/**
 * Las balanzas de una sucursal (migración 134): cada una con su nombre, su marca y la identidad con la que contesta
 * (número de balanza Systel, letra y número de equipo Kretz). Agregar una segunda balanza crea otra fila: nunca pisa
 * la primera. Lo que depende de cada computadora (qué cable USB es) está en local-bindings.ts.
 */

/** Las balanzas de la sucursal. Si la base todavía no tiene la migración 134, devuelve las de antes (sin nombre). */
export async function listBranchScales(branchId: string): Promise<BranchScale[]> {
  if (!supabase) return [];
  const full = await supabase
    .from("scale_profiles")
    .select("scale_key, name, family, brand, model, identity, active, last_seen_at, weighed_format, unit_format, total_format")
    .eq("branch_id", branchId)
    .order("created_at", { ascending: true });
  if (!full.error) return ((full.data ?? []) as Row[]).map(rowToScale);
  if (full.error.code !== "42703") throw full.error;
  const old = await supabase.from("scale_profiles").select("scale_key, brand, model, active, weighed_format, unit_format, total_format").eq("branch_id", branchId);
  if (old.error) throw old.error;
  return ((old.data ?? []) as Row[]).map(rowToScale);
}

export async function registerBranchScale(
  branchId: string,
  s: { key: string | null; name: string | null; family: ScaleFamily; brand: string; model: string | null; identity: Record<string, unknown> }
): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("register_branch_scale", {
    p_branch_id: branchId,
    p_scale_key: s.key,
    p_name: s.name,
    p_family: s.family,
    p_brand: s.brand,
    p_model: s.model,
    p_identity: s.identity
  });
  if (error) throw error;
  return data as string;
}

export async function renameBranchScale(branchId: string, key: string, name: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("rename_branch_scale", { p_branch_id: branchId, p_scale_key: key, p_name: name });
  if (error) throw error;
}

export async function removeBranchScale(branchId: string, key: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("remove_branch_scale", { p_branch_id: branchId, p_scale_key: key });
  if (error) throw error;
}
