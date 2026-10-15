import { supabase } from "../../lib/supabase";
import type { ScaleControlTotals, ScaleReading } from "./scale-control";

/** Control de balanza en el cierre y tickets anulados (migración 104). */

export interface ScaleVoid {
  id: string;
  createdAt: string;
  barcode: string;
  plu: string | null;
  productId: string | null;
  weightKg: number | null;
  amount: number;
  reason: string | null;
}

export interface ScaleControlState {
  totals: ScaleControlTotals;
  saved: (ScaleReading & { cleared: boolean; savedAt: string }) | null;
}

function client() {
  if (!supabase) throw new Error("En modo demostración no se guarda el control de balanza.");
  return supabase;
}

export async function voidScaleTicket(input: {
  posShiftId: string;
  barcode: string;
  plu: string | null;
  productId: string | null;
  weightKg: number | null;
  amount: number;
  reason: string;
}): Promise<void> {
  const { error } = await client().rpc("void_scale_ticket", {
    p_pos_shift_id: input.posShiftId,
    p_barcode: input.barcode,
    p_plu: input.plu,
    p_product_id: input.productId,
    p_weight_kg: input.weightKg,
    p_amount: input.amount,
    p_reason: input.reason
  });
  if (error) throw new Error(error.message);
}

export async function listScaleVoids(posShiftId: string): Promise<ScaleVoid[]> {
  const { data, error } = await client()
    .from("scale_ticket_voids")
    .select("id,created_at,barcode,plu,product_id,weight_kg,amount,reason")
    .eq("pos_shift_id", posShiftId)
    .order("created_at");
  if (error) throw error;
  type Row = {
    id: string; created_at: string; barcode: string; plu: string | null; weight_kg: number | null; amount: number;
    reason: string | null; product_id: string | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    barcode: r.barcode,
    plu: r.plu,
    productId: r.product_id,
    weightKg: r.weight_kg === null ? null : Number(r.weight_kg),
    amount: Number(r.amount),
    reason: r.reason
  }));
}

type ControlJson = {
  system_amount: number; system_kg: number; system_tickets: number; voided_amount: number; voided_kg: number; voided_tickets: number;
  shifts: unknown[];
  saved: null | { scale_amount: number; scale_kg: number | null; scale_tickets: number | null; scale_cleared: boolean; created_at: string;
    system_amount: number; system_kg: number; system_tickets: number; voided_amount: number; voided_kg: number; voided_tickets: number };
};

function mapControl(data: ControlJson): ScaleControlState {
  // Si ya se guardó, se muestra lo que se guardó en ese momento (no se
  // recalcula con ventas posteriores).
  const src = data.saved ?? data;
  return {
    totals: {
      systemAmount: Number(src.system_amount),
      systemKg: Number(src.system_kg),
      systemTickets: Number(src.system_tickets),
      voidedAmount: Number(src.voided_amount),
      voidedKg: Number(src.voided_kg ?? 0),
      voidedTickets: Number(src.voided_tickets),
      shiftCount: Array.isArray(data.shifts) ? data.shifts.length : 1
    },
    saved: data.saved
      ? {
          amount: Number(data.saved.scale_amount),
          kg: data.saved.scale_kg === null ? null : Number(data.saved.scale_kg),
          tickets: data.saved.scale_tickets === null ? null : Number(data.saved.scale_tickets),
          cleared: data.saved.scale_cleared,
          savedAt: data.saved.created_at
        }
      : null
  };
}

export async function getScaleControl(posShiftId: string): Promise<ScaleControlState> {
  const { data, error } = await client().rpc("get_scale_control", { p_pos_shift_id: posShiftId });
  if (error) throw new Error(error.message);
  return mapControl(data as ControlJson);
}

export async function saveScaleControl(posShiftId: string, reading: ScaleReading, cleared: boolean): Promise<ScaleControlState> {
  const { data, error } = await client().rpc("save_scale_control", {
    p_pos_shift_id: posShiftId,
    p_scale_amount: reading.amount,
    p_scale_kg: reading.kg,
    p_scale_tickets: reading.tickets,
    p_scale_cleared: cleared
  });
  if (error) throw new Error(error.message);
  return mapControl(data as ControlJson);
}

/** Migración 125: un papel anulado que se vuelve a cobrar (o al revés) tapa un faltante en el control. */
export interface ScaleTicketVoidHit {
  id: string;
  createdAt: string;
  amount: number;
  by: string | null;
}

export interface ScaleTicketSaleHit {
  saleId: string;
  createdAt: string;
  amount: number;
  by: string | null;
}

let voidCheckPausedUntil = 0;

/** ¿Ese código ya está anulado en los turnos del control de la balanza? null si no (o sin conexión, en < 2,5 s). */
export async function findScaleTicketVoid(posShiftId: string, barcode: string): Promise<ScaleTicketVoidHit | null> {
  if (!supabase) return null;
  // Nunca frena una venta: sin internet, o si la última consulta no contestó a tiempo (por 1 minuto), se sigue sin aviso.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
  if (Date.now() < voidCheckPausedUntil) return null;
  const call = supabase.rpc("find_scale_ticket_void", { p_pos_shift_id: posShiftId, p_barcode: barcode });
  const res = await Promise.race([call, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2500))]).catch(() => null);
  if (res === "timeout") voidCheckPausedUntil = Date.now() + 60_000;
  if (!res || res === "timeout" || res.error || !res.data) return null;
  const d = res.data as { id: string; created_at: string; amount: number; by: string | null };
  return { id: d.id, createdAt: d.created_at, amount: Number(d.amount), by: d.by };
}

/** ¿Ese papel ya se cobró en los turnos del control? Etiqueta: producto + kg. Ticket de total: importe. */
export async function findScaleTicketSale(posShiftId: string, input: { productId: string | null; weightKg: number | null; amount: number }): Promise<ScaleTicketSaleHit | null> {
  const { data, error } = await client().rpc("find_scale_ticket_sale", {
    p_pos_shift_id: posShiftId,
    p_product_id: input.productId,
    p_weight_kg: input.weightKg,
    p_amount: input.amount
  });
  if (error) throw new Error(error.message);
  if (!data) return null;
  const d = data as { sale_id: string; created_at: string; amount: number; by: string | null };
  return { saleId: d.sale_id, createdAt: d.created_at, amount: Number(d.amount), by: d.by };
}

export async function undoScaleTicketVoid(posShiftId: string, voidId: string): Promise<void> {
  const { error } = await client().rpc("undo_scale_ticket_void", { p_pos_shift_id: posShiftId, p_void_id: voidId });
  if (error) throw new Error(error.message);
}
