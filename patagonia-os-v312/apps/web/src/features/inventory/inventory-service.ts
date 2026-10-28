import type { Product } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

export async function listProductsForBranch(branchId: string, includeInactive = false): Promise<Product[]> {
  if (!supabase) return [];

  // Supabase devuelve como máximo 1000 filas por consulta: se pide por páginas
  // (orden estable por nombre + id) para no cortar el catálogo en silencio.
  const PAGE_SIZE = 1000;
  const rows: {
    id: string; code: string; name: string; unit: Product["unit"]; cost: number | string; price_retail: number | string;
    min_stock: number | string; stock: number | string; active: boolean; category_id: string | null;
    stock_source_id: string | null; stock_factor: number | string | null;
  }[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from("products_with_stock")
      .select("id,code,name,unit,cost,price_retail,min_stock,stock,active,category_id,stock_source_id,stock_factor")
      .eq("branch_id", branchId)
      .order("name")
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (!includeInactive) query = query.eq("active", true);

    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    cost: Number(row.cost),
    priceRetail: Number(row.price_retail),
    stock: Number(row.stock),
    minStock: Number(row.min_stock),
    active: row.active,
    categoryId: row.category_id ?? undefined,
    stockSourceId: row.stock_source_id ?? undefined,
    stockFactor: row.stock_source_id ? Number(row.stock_factor ?? 1) : undefined
  }));
}

/**
 * Vincula una presentación a su producto principal (descuenta stock de él) o
 * la desvincula (sourceId null). Al vincular, el stock propio que tenía queda
 * en cero y, con moveStock, se suma al principal (x factor).
 */
export async function setProductStockSource(input: {
  productId: string;
  sourceId: string | null;
  factor: number;
  moveStock: boolean;
}): Promise<{ cleared: number; moved: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("set_product_stock_source", {
    p_product_id: input.productId,
    p_source_id: input.sourceId,
    p_factor: input.factor,
    p_move_stock: input.moveStock
  });
  if (error) throw error;
  return { cleared: Number(data?.cleared ?? 0), moved: Number(data?.moved ?? 0) };
}

export interface CreateProductInput {
  branchId: string;
  code: string;
  name: string;
  unit: Product["unit"];
  cost: number;
  priceRetail: number;
  minStock: number;
  categoryId?: string;
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
    p_min_stock: input.minStock,
    p_category_id: input.categoryId ?? null
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
  categoryId?: string;
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
    p_active: input.active,
    p_category_id: input.categoryId ?? null
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

export interface BulkPriceChange {
  id: string;
  priceRetail: number;
  cost: number;
}

export async function bulkUpdateProductPrices(changes: BulkPriceChange[]): Promise<{ updated: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("bulk_update_product_prices", {
    p_items: changes.map((c) => ({ product_id: c.id, price_retail: c.priceRetail, cost: c.cost }))
  });
  if (error) throw error;
  return { updated: Number((data as { updated?: number } | null)?.updated ?? 0) };
}

/** Elimina un producto SIN historia (migración 139). Si ya tiene ventas, compras o stock, la base lo rechaza y pide darlo de baja. */
export async function deleteProduct(productId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("delete_product", { p_product_id: productId });
  if (error) throw error;
}

/** Dar de baja (no aparece para vender) o reactivar un producto, sin pasar por Editar. */
export async function setProductActive(productId: string, active: boolean): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_product_active", { p_product_id: productId, p_active: active });
  if (error) throw error;
}

/** IVA de cada producto (migración 154): id → alícuota, o null = el IVA general de Facturas. */
export async function listProductVatRates(): Promise<Record<string, number | null>> {
  if (!supabase) return {};
  const out: Record<string, number | null> = {};
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    // Por la vista: la tabla products no se lee directo desde la 051 (por eso Stock mostraba "General" siempre).
    const { data, error } = await supabase.from("products_price_list").select("id,vat_rate").order("id").range(from, from + PAGE_SIZE - 1);
    if (error) {
      // Base sin la migración 154 todavía: sin IVA por producto, nada se rompe.
      if ((error as { code?: string }).code === "42703") return {};
      throw error;
    }
    for (const row of data ?? []) out[row.id] = row.vat_rate === null ? null : Number(row.vat_rate);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return out;
}

/** Cambia el IVA de varios productos, por id o por código. rate null = vuelve al IVA general. */
export async function setProductsVatRate(input: { productIds?: string[]; codes?: string[]; rate: number | null }): Promise<number> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("set_products_vat_rate", {
    p_product_ids: input.productIds ?? null,
    p_codes: input.codes ?? null,
    p_rate: input.rate
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/** Paquetes por producto de la sucursal (migración 157, a pedido: companies.features 'paquetes'). Solo los que cuentan paquetes. */
export async function listProductPackages(branchId: string): Promise<Record<string, number>> {
  if (!supabase) return {};
  const { data, error } = await supabase.rpc("list_product_packages", { p_branch_id: branchId });
  if (error) throw error;
  return Object.fromEntries(((data ?? []) as { product_id: string; packages: number }[]).map((r) => [r.product_id, Number(r.packages)]));
}

/** "Envasé N" (suma) o "Contar" (deja el número contado). Devuelve cuántos paquetes quedaron. */
export async function registerProductPackages(input: { branchId: string; productId: string; kind: "envasado" | "conteo"; count: number }): Promise<number> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("register_product_packages", {
    p_branch_id: input.branchId,
    p_product_id: input.productId,
    p_kind: input.kind,
    p_count: input.count
  });
  if (error) throw error;
  return Number(data);
}

/** Borra los paquetes anotados de un producto en la sucursal (migración 160); los kilos no se tocan. */
export async function clearProductPackages(branchId: string, productId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("clear_product_packages", { p_branch_id: branchId, p_product_id: productId });
  if (error) throw error;
}
