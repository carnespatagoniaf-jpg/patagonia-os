import { supabase } from "../../lib/supabase";

export type SalesMode = "turnos" | "mostrador" | null;

export interface Branch {
  id: string;
  name: string;
  sales_mode: SalesMode;
}

export async function listBranches(): Promise<Branch[]> {
  if (!supabase) return [];

  const { data, error } = await supabase.from("branches").select("id,name,sales_mode").eq("active", true).order("name");
  if (error) throw error;
  return data ?? [];
}

export async function createBranch(name: string): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_branch", { p_name: name });
  if (error) throw error;
  return { id: data.id };
}

export async function setBranchSalesMode(branchId: string, salesMode: SalesMode): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("set_branch_sales_mode", { p_branch_id: branchId, p_sales_mode: salesMode });
  if (error) throw error;
}
