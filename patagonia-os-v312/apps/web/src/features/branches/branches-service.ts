import { supabase } from "../../lib/supabase";

export interface Branch {
  id: string;
  name: string;
}

export async function listBranches(): Promise<Branch[]> {
  if (!supabase) return [];

  const { data, error } = await supabase.from("branches").select("id,name").eq("active", true).order("name");
  if (error) throw error;
  return data ?? [];
}

export async function createBranch(name: string): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_branch", { p_name: name });
  if (error) throw error;
  return { id: data.id };
}
