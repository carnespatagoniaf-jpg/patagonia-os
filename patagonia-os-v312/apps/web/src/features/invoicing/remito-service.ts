import { supabase } from "../../lib/supabase";
import { parseRemito, parseRemitoCai, type Remito, type RemitoCai } from "./remito-r";

// Remito R con CAI (migración 147, plan Full). Las tablas se leen directo (RLS
// por empresa); emitir, anular y cargar CAI van por sus funciones.

export async function listRemitoCais(): Promise<RemitoCai[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("remito_cai").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(parseRemitoCai);
}

export async function listRemitos(limit = 200): Promise<Remito[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("remitos").select("*").order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(parseRemito);
}

/** Último número emitido por punto de venta (para saber si quedan números). */
export async function listRemitoNumbers(): Promise<Array<{ pointOfSale: number; number: number }>> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("remitos").select("point_of_sale,number").order("number", { ascending: false }).limit(500);
  if (error) throw error;
  return ((data ?? []) as Array<{ point_of_sale: number; number: number }>).map((r) => ({ pointOfSale: Number(r.point_of_sale), number: Number(r.number) }));
}

export async function getRemito(id: string): Promise<Remito | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("remitos").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? parseRemito(data as Record<string, unknown>) : null;
}

/** El remito emitido (no anulado) de una venta a cuenta, si tiene. */
export async function getChargeRemito(chargeId: string): Promise<Remito | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("remitos").select("*").eq("customer_charge_id", chargeId).eq("status", "emitido").maybeSingle();
  if (error) throw error;
  return data ? parseRemito(data as Record<string, unknown>) : null;
}

export async function saveRemitoCai(input: { pointOfSale: number; cai: string; caiDue: string; numberFrom: number; numberTo: number }): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("save_remito_cai", {
    p_point_of_sale: input.pointOfSale,
    p_cai: input.cai,
    p_cai_due: input.caiDue,
    p_number_from: input.numberFrom,
    p_number_to: input.numberTo
  });
  if (error) throw error;
}

export async function setRemitoCaiActive(caiId: string, active: boolean): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_remito_cai_active", { p_cai_id: caiId, p_active: active });
  if (error) throw error;
}

export interface IssueRemitoInput {
  chargeId: string;
  receiverCondition: string;
  receiverDoc: string;
  receiverAddress: string;
  deliveryAddress: string;
  carrier: { name: string; cuit: string; address: string } | null;
  notes: string;
  showValues: boolean;
}

export async function issueRemito(input: IssueRemitoInput): Promise<Remito> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("issue_remito", {
    p_charge_id: input.chargeId,
    p_receiver_address: input.receiverAddress,
    p_receiver_doc: input.receiverDoc,
    p_receiver_condition: input.receiverCondition,
    p_delivery_address: input.deliveryAddress,
    p_carrier_name: input.carrier?.name ?? null,
    p_carrier_cuit: input.carrier?.cuit ?? null,
    p_carrier_address: input.carrier?.address ?? null,
    p_notes: input.notes,
    p_show_values: input.showValues
  });
  if (error) throw error;
  const remito = await getRemito(String(data));
  if (!remito) throw new Error("El remito se emitió pero no se pudo leer. Buscalo en Facturas → Remito R.");
  return remito;
}

/** El último remito de un cliente, para proponer su domicilio comercial. */
export async function getLastCustomerRemito(customerId: string): Promise<Remito | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("remitos").select("*").eq("customer_id", customerId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? parseRemito(data as Record<string, unknown>) : null;
}

export async function voidRemito(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("void_remito", { p_remito_id: id });
  if (error) throw error;
}
