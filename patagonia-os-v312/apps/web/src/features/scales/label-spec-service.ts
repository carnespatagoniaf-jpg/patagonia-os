import { supabase } from "../../lib/supabase";
import { toError } from "../../lib/supabase-error";
import { isLabelSpec, type LabelSpec, type LabelSpecRow } from "./label-spec";

/**
 * Perfiles de etiqueta de las balanzas (migración 222). Solo se usan con 'balanzas_v2' encendido en la empresa.
 * Sin la migración (columna inexistente, función inexistente) devuelven "no hay" y la web sigue como antes.
 */

/** Las balanzas de la sucursal con su perfil y su historial (para el lector por balanza de Mostrador y Clientes). */
export async function loadBranchLabelSpecRows(branchId: string): Promise<LabelSpecRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("scale_profiles")
    .select("scale_key, name, status, label_spec, label_spec_history")
    .eq("branch_id", branchId)
    .order("created_at", { ascending: true });
  if (error) throw toError(error);
  return (data ?? []) as LabelSpecRow[];
}

/** El perfil de UNA balanza (null = no tiene, o la base todavía no tiene la 222). */
export async function loadScaleLabelSpec(branchId: string, scaleKey: string): Promise<LabelSpec | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("scale_profiles").select("label_spec").eq("branch_id", branchId).eq("scale_key", scaleKey).maybeSingle();
  if (error) {
    if (error.code === "42703") return null;
    throw toError(error);
  }
  const spec = (data as { label_spec?: unknown } | null)?.label_spec;
  return isLabelSpec(spec) ? spec : null;
}

/** Guarda el perfil de ESA balanza (el anterior queda vigente 7 días). La base rechaza un inicio que ya usa otra. */
export async function saveScaleLabelSpec(branchId: string, scaleKey: string, spec: LabelSpec): Promise<LabelSpec> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("set_scale_label_spec", { p_branch_id: branchId, p_scale_key: scaleKey, p_spec: spec });
  if (error) throw toError(error);
  return data as LabelSpec;
}

export interface PrefixAllocation {
  prefix: string;
  /** true = la balanza recibió un inicio nuevo: hay que mandárselo al sincronizar. */
  changed: boolean;
  spec: LabelSpec;
}

/** Inicio propio al registrar una balanza: la que ya tiene el suyo lo conserva; la que choca recibe uno libre. */
export async function allocateScalePrefix(branchId: string, scaleKey: string): Promise<PrefixAllocation | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("allocate_scale_prefix", { p_branch_id: branchId, p_scale_key: scaleKey });
  if (error) {
    if (error.code === "PGRST202") return null;
    throw toError(error);
  }
  const r = data as PrefixAllocation | null;
  return r && isLabelSpec(r.spec) ? r : null;
}
