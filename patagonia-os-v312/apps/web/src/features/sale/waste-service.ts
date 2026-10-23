import { supabase } from "../../lib/supabase";

// Decomisos (migraciones 151 y 152, todos los planes): lo que se tira (vencido, en mal estado,
// roto) se carga en Mostrador, descuenta el stock y queda en Reportes → Merma.

export type WasteReason = "vencido" | "mal_estado" | "roto" | "otro";

export interface StockWaste {
  id: string;
  productId: string;
  productName: string;
  unit: string | null;
  quantity: number;
  unitCost: number;
  reason: WasteReason;
  notes: string | null;
  createdAt: string;
  voided: boolean;
}

export async function registerStockWaste(input: {
  branchId: string;
  productId: string;
  quantity: number;
  reason: WasteReason;
  notes: string;
  posShiftId: string | null;
  barcode: string | null;
}): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("register_stock_waste", {
    p_branch_id: input.branchId,
    p_product_id: input.productId,
    p_quantity: input.quantity,
    p_reason: input.reason,
    p_notes: input.notes,
    p_pos_shift_id: input.posShiftId,
    p_barcode: input.barcode
  });
  if (error) throw error;
  return String(data);
}

export async function voidStockWaste(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("void_stock_waste", { p_waste_id: id });
  if (error) throw error;
}

/** Los decomisos de una caja (turno de Mostrador), del más nuevo al más viejo. */
export async function listShiftWastes(posShiftId: string): Promise<StockWaste[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("stock_wastes")
    .select("id,product_id,quantity,unit_cost,reason,notes,created_at,voided_at,products(name,unit)")
    .eq("pos_shift_id", posShiftId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const product = (r.products ?? {}) as { name?: string; unit?: string };
    return {
      id: String(r.id),
      productId: String(r.product_id),
      productName: product.name ?? "",
      unit: product.unit ?? null,
      quantity: Number(r.quantity),
      unitCost: Number(r.unit_cost ?? 0),
      reason: r.reason as WasteReason,
      notes: (r.notes as string | null) ?? null,
      createdAt: String(r.created_at),
      voided: r.voided_at !== null && r.voided_at !== undefined
    };
  });
}
