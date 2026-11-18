import { supabase } from "../../lib/supabase";
import { toError } from "../../lib/supabase-error";
import { parseRecPoint, parseRecRemito, parseRecSettings, type CodigoDescripcion, type RecPoint, type RecRemito, type RecSettings } from "./rec-logic";

// Remito Electrónico Cárnico (migración 202, plan Full). Las tablas se leen
// directo (RLS por empresa); crear va por create_rec_remito y todo lo de ARCA
// por la Edge Function arca-remito (separada de arca-invoice).

export async function getRecSettings(): Promise<RecSettings | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("rec_settings").select("*").maybeSingle();
  // Antes de la migración la tabla no existe: el panel no se muestra.
  if (error && (error.code === "42P01" || error.code === "PGRST205")) return null;
  if (error) throw toError(error);
  return parseRecSettings(data as Record<string, unknown> | null);
}

export async function listRecPoints(): Promise<RecPoint[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("rec_points").select("*").order("point_of_emission");
  if (error) throw toError(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map(parseRecPoint);
}

export async function listRecRemitos(limit = 100): Promise<RecRemito[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("rec_remitos")
    .select("*, rec_remito_items(*)")
    .neq("status", "descartado")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw toError(error);
  return ((data ?? []) as Array<Record<string, unknown>>).map(parseRecRemito);
}

export async function getRecRemito(id: string): Promise<RecRemito | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("rec_remitos").select("*, rec_remito_items(*)").eq("id", id).maybeSingle();
  if (error) throw toError(error);
  return data ? parseRecRemito(data as Record<string, unknown>) : null;
}

export async function saveRecSettings(categoria: number | null, desc: string | null): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("save_rec_settings", { p_categoria_emisor: categoria, p_categoria_emisor_desc: desc });
  if (error) throw toError(error);
}

export async function saveRecPoint(point: number, branchId: string | null, label: string | null, active = true): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("save_rec_point", { p_point: point, p_branch_id: branchId, p_label: label, p_active: active });
  if (error) throw toError(error);
}

export async function createRecRemito(clientId: string, payload: Record<string, unknown>): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("create_rec_remito", { p_client_id: clientId, p_data: payload });
  if (error) throw toError(error);
  return String(data);
}

export async function discardRecRemito(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("discard_rec_remito", { p_id: id });
  if (error) throw toError(error);
}

/** Último código de ARCA usado por producto. */
export async function listRecProductCodes(): Promise<Map<string, string>> {
  if (!supabase) return new Map();
  const { data, error } = await supabase.from("rec_product_codes").select("product_id,cod_tipo_prod");
  if (error) throw toError(error);
  return new Map(((data ?? []) as Array<{ product_id: string; cod_tipo_prod: string }>).map((r) => [r.product_id, r.cod_tipo_prod]));
}

export interface RecCustomerOption {
  id: string;
  name: string;
  taxId: string | null;
  locality: string | null;
}

export async function listRecCustomers(): Promise<RecCustomerOption[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("customers").select("id,name,tax_id,locality").eq("active", true).order("name").limit(1000);
  if (error) throw toError(error);
  return ((data ?? []) as Array<{ id: string; name: string; tax_id: string | null; locality: string | null }>).map((c) => ({
    id: c.id,
    name: c.name,
    taxId: c.tax_id,
    locality: c.locality
  }));
}

export interface RecProductOption {
  id: string;
  code: string | null;
  name: string;
}

export async function listRecProducts(): Promise<RecProductOption[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("products").select("id,code,name").eq("active", true).is("stock_source_id", null).order("name").limit(2000);
  if (error) throw toError(error);
  return ((data ?? []) as Array<{ id: string; code: string | null; name: string }>).map((p) => ({ id: p.id, code: p.code, name: p.name }));
}

async function invokeRemito<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.functions.invoke("arca-remito", { body });
  if (error) {
    let message = error.message;
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const payload = await context.json();
        if (payload?.error) message = payload.error;
      } catch {
        // queda el mensaje de supabase-js
      }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(String(data.error));
  return data as T;
}

export function checkRecConnection(): Promise<{ ok: boolean; message: string; env: string }> {
  return invokeRemito({ action: "check" });
}

export function recDomicilios(cuit: string): Promise<{ items: CodigoDescripcion[] }> {
  return invokeRemito({ action: "domicilios", cuit });
}

export async function recAction(action: "send" | "emit" | "refresh" | "void", remitoId: string): Promise<void> {
  await invokeRemito({ action, remitoId });
}
