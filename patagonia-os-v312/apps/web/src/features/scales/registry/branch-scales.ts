import { supabase } from "../../../lib/supabase";
import type { InstallRecord } from "../install-status";
import { rowToScale, type BranchScale, type ScaleFamily, type ScaleRow as Row } from "./scale-identity";
import { toError } from "../../../lib/supabase-error";
import { parseDuplicateGroups, type DuplicateGroup } from "./scale-merge";

export * from "./scale-identity";

/**
 * Las balanzas de una sucursal (migración 134): cada una con su nombre, su marca y la identidad con la que contesta
 * (número de balanza Systel, letra y número de equipo Kretz). Agregar una segunda balanza crea otra fila: nunca pisa
 * la primera. Lo que depende de cada computadora (qué cable USB es) está en local-bindings.ts.
 */

/** Las balanzas de la sucursal. Si la base todavía no tiene la migración 134, devuelve las de antes (sin nombre). */
export async function listBranchScales(branchId: string): Promise<BranchScale[]> {
  if (!supabase) return [];
  // Con los registros unidos (migración 225): vienen todos, también los unidos (MyScale los separa con mergedInto).
  const withMerged = await supabase
    .from("scale_profiles")
    .select("scale_key, name, family, brand, model, identity, active, last_seen_at, weighed_format, unit_format, total_format, install, merged_into")
    .eq("branch_id", branchId)
    .order("created_at", { ascending: true });
  if (!withMerged.error) return ((withMerged.data ?? []) as Row[]).map(rowToScale);
  if (withMerged.error.code !== "42703") throw withMerged.error;
  // Con el estado de la instalación (migración 165); sin ella, como antes.
  const withInstall = await supabase
    .from("scale_profiles")
    .select("scale_key, name, family, brand, model, identity, active, last_seen_at, weighed_format, unit_format, total_format, install")
    .eq("branch_id", branchId)
    .order("created_at", { ascending: true });
  if (!withInstall.error) return ((withInstall.data ?? []) as Row[]).map(rowToScale);
  if (withInstall.error.code !== "42703") throw withInstall.error;
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
  if (error) throw toError(error);
  return data as string;
}

/** Guarda pasos de la instalación en la ficha de la balanza. Sin la migración 165 no hace nada (queda en la computadora). */
export async function saveScaleInstall(branchId: string, key: string, patch: InstallRecord): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.rpc("set_branch_scale_install", { p_branch_id: branchId, p_scale_key: key, p_patch: patch });
  if (error && error.code !== "PGRST202") throw toError(error);
}

/** Mostrador leyó bien una etiqueta de balanza (como mucho una escritura cada 10 minutos por balanza, en la base). */
export async function markScalesSaleTested(branchId: string, detail: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.rpc("mark_branch_scales_sale_tested", { p_branch_id: branchId, p_detail: detail });
  if (error && error.code !== "PGRST202") throw toError(error);
}

export async function renameBranchScale(branchId: string, key: string, name: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("rename_branch_scale", { p_branch_id: branchId, p_scale_key: key, p_name: name });
  if (error) throw toError(error);
}

export async function removeBranchScale(branchId: string, key: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("remove_branch_scale", { p_branch_id: branchId, p_scale_key: key });
  if (error) throw toError(error);
}

/** Grupos de registros que parecen la misma balanza (migración 225). Sin la migración, ninguno. Solo dueño o administrador. */
export async function listDuplicateScaleCandidates(branchId: string): Promise<DuplicateGroup[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("list_duplicate_scale_candidates", { p_branch_id: branchId });
  if (error) {
    if (error.code === "PGRST202") return [];
    throw toError(error);
  }
  return parseDuplicateGroups(data);
}

/** Une los registros al que queda. Devuelve lo que contestó la base (con formatos distintos, no une: ver mergeResultText). */
export async function mergeBranchScales(branchId: string, keepKey: string, mergeKeys: string[]): Promise<unknown> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("merge_branch_scales", { p_branch_id: branchId, p_keep_key: keepKey, p_merge_keys: mergeKeys });
  if (error) throw toError(error);
  return data;
}

/** "Son distintas": no se vuelve a preguntar por ese grupo. */
export async function markScalesDistinct(branchId: string, keys: string[]): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("mark_scales_distinct", { p_branch_id: branchId, p_keys: keys });
  if (error) throw toError(error);
}
