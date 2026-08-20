import { supabase } from "../../lib/supabase";

export interface ProductCategory {
  id: string;
  name: string;
}

export async function listProductCategories(): Promise<ProductCategory[]> {
  if (!supabase) return [];

  const { data, error } = await supabase.from("product_categories").select("id,name").order("name");
  if (error) throw error;
  return data ?? [];
}

export async function createProductCategory(name: string): Promise<ProductCategory> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_product_category", { p_name: name });
  if (error) throw error;
  return { id: data.id, name: data.name };
}

export async function updateProductCategory(id: string, name: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("update_product_category", { p_category_id: id, p_name: name });
  if (error) throw error;
}

export async function deleteProductCategory(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_product_category", { p_category_id: id });
  if (error) throw error;
}
