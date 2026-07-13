import type { Product } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

export async function listProductsForBranch(branchId: string): Promise<Product[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("products_with_stock")
    .select("id,code,name,unit,cost,price_retail,min_stock,stock")
    .eq("branch_id", branchId)
    .eq("active", true)
    .order("name");

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    cost: Number(row.cost),
    priceRetail: Number(row.price_retail),
    stock: Number(row.stock),
    minStock: Number(row.min_stock)
  }));
}
