import type { Product } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

export async function listProductsForBranch(branchId: string, includeInactive = false): Promise<Product[]> {
  if (!supabase) return [];

  let query = supabase
    .from("products_with_stock")
    .select("id,code,name,unit,cost,price_retail,min_stock,stock,active")
    .eq("branch_id", branchId)
    .order("name");
  if (!includeInactive) query = query.eq("active", true);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    cost: Number(row.cost),
    priceRetail: Number(row.price_retail),
    stock: Number(row.stock),
    minStock: Number(row.min_stock),
    active: row.active
  }));
}

export interface CreateProductInput {
  branchId: string;
  code: string;
  name: string;
  unit: Product["unit"];
  cost: number;
  priceRetail: number;
  minStock: number;
}

export async function createProduct(input: CreateProductInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_product", {
    p_branch_id: input.branchId,
    p_code: input.code,
    p_name: input.name,
    p_unit: input.unit,
    p_cost: input.cost,
    p_price_retail: input.priceRetail,
    p_min_stock: input.minStock
  });

  if (error) throw error;
  return { id: data.id };
}

export interface UpdateProductInput {
  branchId: string;
  id: string;
  code: string;
  name: string;
  unit: Product["unit"];
  cost: number;
  priceRetail: number;
  minStock: number;
  active: boolean;
}

export async function updateProduct(input: UpdateProductInput): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("update_product", {
    p_branch_id: input.branchId,
    p_product_id: input.id,
    p_code: input.code,
    p_name: input.name,
    p_unit: input.unit,
    p_cost: input.cost,
    p_price_retail: input.priceRetail,
    p_min_stock: input.minStock,
    p_active: input.active
  });

  if (error) throw error;
}

export interface AdjustProductStockInput {
  branchId: string;
  productId: string;
  countedQuantity: number;
  reason: string;
}

export interface AdjustProductStockResult {
  previous: number;
  counted: number;
  delta: number;
}

export async function adjustProductStock(input: AdjustProductStockInput): Promise<AdjustProductStockResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("adjust_product_stock", {
    p_branch_id: input.branchId,
    p_product_id: input.productId,
    p_counted_quantity: input.countedQuantity,
    p_reason: input.reason
  });

  if (error) throw error;
  return { previous: Number(data.previous), counted: Number(data.counted), delta: Number(data.delta) };
}
