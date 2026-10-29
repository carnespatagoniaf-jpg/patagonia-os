import { supabase } from "../../lib/supabase";
import type { FrigoCamara, FrigoDt, FrigoMedia, FrigoSalida, SalidaKind } from "./frigo-logic";

// Frigorífico (migración 169): las tablas se leen directo (RLS por empresa y
// pantalla 'frigorifico') y todo cambio pasa por las funciones de la base.

function requireClient() {
  if (!supabase) throw new Error("Supabase no está configurado.");
  return supabase;
}

const PAGE_SIZE = 1000;

/** Supabase devuelve como máximo 1000 filas por consulta: se pide por páginas. */
async function allRows<T>(table: string, columns: string, order: string): Promise<T[]> {
  const client = requireClient();
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client.from(table).select(columns).order(order).order("id").range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as T[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

export async function listCamaras(): Promise<FrigoCamara[]> {
  const rows = await allRows<{ id: string; number: number; name: string; capacity: number | null; active: boolean }>(
    "frigo_camaras", "id,number,name,capacity,active", "number"
  );
  return rows;
}

export async function listDts(): Promise<FrigoDt[]> {
  const rows = await allRows<{
    id: string; branch_id: string; dt_number: string; dt_date: string; producer: string; renspa: string | null; origin: string | null;
    category: string; heads: number; tropa: number | null; slaughter_date: string | null; status: FrigoDt["status"]; notes: string | null;
  }>("frigo_dts", "id,branch_id,dt_number,dt_date,producer,renspa,origin,category,heads,tropa,slaughter_date,status,notes", "created_at");
  return rows.map((r) => ({
    id: r.id, branchId: r.branch_id, dtNumber: r.dt_number, dtDate: r.dt_date, producer: r.producer, renspa: r.renspa, origin: r.origin,
    category: r.category, heads: r.heads, tropa: r.tropa, slaughterDate: r.slaughter_date, status: r.status, notes: r.notes
  }));
}

export async function listMedias(): Promise<FrigoMedia[]> {
  const rows = await allRows<{
    id: string; dt_id: string; tropa: number; garron: number; slaughter_date: string; animal: number; side: 1 | 2;
    kg: number | string; camara_id: string; salida_id: string | null;
  }>("frigo_medias", "id,dt_id,tropa,garron,slaughter_date,animal,side,kg,camara_id,salida_id", "slaughter_date");
  return rows.map((r) => ({
    id: r.id, dtId: r.dt_id, tropa: r.tropa, garron: r.garron, slaughterDate: r.slaughter_date, animal: r.animal, side: r.side,
    kg: Number(r.kg), camaraId: r.camara_id, salidaId: r.salida_id
  }));
}

export async function listSalidas(): Promise<FrigoSalida[]> {
  const rows = await allRows<{
    id: string; number: number; salida_date: string; kind: SalidaKind; customer_id: string | null; price_per_kg: number | string | null;
    total_kg: number | string; total: number | string; notes: string | null; voided_at: string | null; voided_reason: string | null;
    customers: { name: string } | null; dest: { name: string } | null; products: { name: string } | null;
  }>(
    "frigo_salidas",
    "id,number,salida_date,kind,customer_id,price_per_kg,total_kg,total,notes,voided_at,voided_reason,customers(name),dest:branches!frigo_salidas_dest_branch_id_fkey(name),products(name)",
    "number"
  );
  return rows.map((r) => ({
    id: r.id, number: r.number, salidaDate: r.salida_date, kind: r.kind, customerId: r.customer_id, customerName: r.customers?.name ?? null,
    destBranchName: r.dest?.name ?? null, productName: r.products?.name ?? null,
    pricePerKg: r.price_per_kg == null ? null : Number(r.price_per_kg), totalKg: Number(r.total_kg), total: Number(r.total),
    notes: r.notes, voidedAt: r.voided_at, voidedReason: r.voided_reason
  }));
}

/** Clientes activos para elegir en una venta (la deuda se ve en Clientes). */
export async function listActiveCustomers(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await requireClient().from("customers").select("id,name").eq("active", true).order("name").limit(2000);
  if (error) throw error;
  return (data ?? []) as { id: string; name: string }[];
}

export async function saveCamara(input: { id: string | null; number: number; name: string; capacity: number | null; active: boolean }) {
  const { error } = await requireClient().rpc("frigo_save_camara", {
    p_id: input.id, p_number: input.number, p_name: input.name, p_capacity: input.capacity, p_active: input.active
  });
  if (error) throw error;
}

export async function createDt(input: {
  branchId: string; dtNumber: string; dtDate: string; producer: string; renspa: string; origin: string; category: string; heads: number; notes: string;
}) {
  const { error } = await requireClient().rpc("frigo_create_dt", {
    p_branch_id: input.branchId, p_dt_number: input.dtNumber, p_dt_date: input.dtDate, p_producer: input.producer, p_renspa: input.renspa,
    p_origin: input.origin, p_category: input.category, p_heads: input.heads, p_notes: input.notes
  });
  if (error) throw error;
}

export async function deleteDt(dtId: string) {
  const { error } = await requireClient().rpc("frigo_delete_dt", { p_dt_id: dtId });
  if (error) throw error;
}

export async function slaughter(input: { dtId: string; tropa: number; date: string; medias: { kg: number; camaraId: string }[] }) {
  const { data, error } = await requireClient().rpc("frigo_slaughter", {
    p_dt_id: input.dtId, p_tropa: input.tropa, p_slaughter_date: input.date,
    p_medias: input.medias.map((m) => ({ kg: m.kg, camara_id: m.camaraId }))
  });
  if (error) throw error;
  return data as { tropa: number; first_garron: number; last_garron: number; total_kg: number };
}

export async function moveMedias(mediaIds: string[], camaraId: string) {
  const { error } = await requireClient().rpc("frigo_move_medias", { p_media_ids: mediaIds, p_camara_id: camaraId });
  if (error) throw error;
}

export async function createSalida(input: {
  branchId: string; date: string; kind: SalidaKind; customerId: string | null; destBranchId: string | null; productId: string | null;
  pricePerKg: number | null; mediaIds: string[]; notes: string;
}) {
  const { data, error } = await requireClient().rpc("frigo_create_salida", {
    p_branch_id: input.branchId, p_salida_date: input.date, p_kind: input.kind, p_customer_id: input.customerId,
    p_dest_branch_id: input.destBranchId, p_product_id: input.productId, p_price_per_kg: input.pricePerKg,
    p_media_ids: input.mediaIds, p_notes: input.notes
  });
  if (error) throw error;
  return data as { id: string; number: number; medias: number; total_kg: number; total: number };
}

export async function voidSalida(salidaId: string, reason: string) {
  const { error } = await requireClient().rpc("frigo_void_salida", { p_salida_id: salidaId, p_reason: reason });
  if (error) throw error;
}
