import { supabase } from "../../lib/supabase";

// Resumen por sucursal (Sucursales) y transferencia de stock entre
// sucursales. Ver migración 098_branches_overview.sql. Solo dueño/admin
// (branches.manage), igual que el selector de sucursal del menú.

export interface BranchOverview {
  branchId: string;
  branchName: string;
  salesMode: "turnos" | "mostrador" | null;
  stockValue: number;
  productCount: number;
  salesTodayCount: number;
  salesTodayTotal: number;
  shiftOpen: boolean;
}

interface BranchOverviewRow {
  branch_id: string;
  branch_name: string;
  sales_mode: "turnos" | "mostrador" | null;
  stock_value: number | string;
  product_count: number | string;
  sales_today_count: number | string;
  sales_today_total: number | string;
  shift_open: boolean;
}

export async function getBranchesOverview(): Promise<BranchOverview[]> {
  if (!supabase) return [];

  const { data, error } = await supabase.rpc("get_branches_overview");
  if (error) throw error;
  return ((data ?? []) as BranchOverviewRow[]).map((row) => ({
    branchId: row.branch_id,
    branchName: row.branch_name,
    salesMode: row.sales_mode,
    stockValue: Number(row.stock_value),
    productCount: Number(row.product_count),
    salesTodayCount: Number(row.sales_today_count),
    salesTodayTotal: Number(row.sales_today_total),
    shiftOpen: row.shift_open
  }));
}

export interface TransferBranchStockInput {
  fromBranchId: string;
  toBranchId: string;
  productId: string;
  quantity: number;
  notes?: string;
}

export async function transferBranchStock(input: TransferBranchStockInput): Promise<{ transferId: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("transfer_branch_stock", {
    p_from_branch_id: input.fromBranchId,
    p_to_branch_id: input.toBranchId,
    p_product_id: input.productId,
    p_quantity: input.quantity,
    p_notes: input.notes ?? null
  });
  if (error) throw error;
  return { transferId: data as string };
}
