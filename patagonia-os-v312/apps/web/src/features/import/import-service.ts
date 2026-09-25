import { supabase } from "../../lib/supabase";
import type { CustomerPayload, ProductPayload, SupplierPayload } from "./import-parse";

export interface ImportCounts {
  created: number;
  updated: number;
  skipped: number;
  stockAdjusted: number;
}

function counts(data: unknown): ImportCounts {
  const d = (data ?? {}) as Record<string, number>;
  return { created: d.created ?? 0, updated: d.updated ?? 0, skipped: d.skipped ?? 0, stockAdjusted: d.stock_adjusted ?? 0 };
}

export async function importProducts(branchId: string, rows: ProductPayload[], updateExisting: boolean): Promise<ImportCounts> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("import_products", { p_branch_id: branchId, p_rows: rows, p_update_existing: updateExisting });
  if (error) throw error;
  return counts(data);
}

export async function importSuppliers(rows: SupplierPayload[]): Promise<ImportCounts> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("import_suppliers", { p_rows: rows });
  if (error) throw error;
  return counts(data);
}

export async function importCustomers(branchId: string, rows: CustomerPayload[]): Promise<ImportCounts> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("import_customers", { p_branch_id: branchId, p_rows: rows });
  if (error) throw error;
  return counts(data);
}
