import { supabase } from "../../lib/supabase";
import type { PriceList } from "./price-lists";

/** La tabla/vista no existe todavía (migración 166 sin aplicar): se sigue como si no hubiera listas. */
function missingRelation(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205" || error?.code === "42703" || error?.code === "PGRST204";
}

export async function listPriceLists(): Promise<PriceList[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("price_lists").select("id,name,base,pct,active").order("created_at");
  if (error) {
    if (missingRelation(error)) return [];
    throw error;
  }
  return (data ?? []).map((r) => ({ id: r.id, name: r.name, base: r.base, pct: Number(r.pct), active: r.active }));
}

/** Precio de cada producto en cada lista activa: product_id → list_id → {price, manual}. */
export async function listProductListPrices(): Promise<Map<string, Record<string, { price: number; manual: boolean }>>> {
  const result = new Map<string, Record<string, { price: number; manual: boolean }>>();
  if (!supabase) return result;
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("product_list_prices_view")
      .select("product_id,list_id,price,manual")
      .order("product_id")
      .order("list_id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      if (missingRelation(error)) return result;
      throw error;
    }
    for (const r of data ?? []) {
      const entry = result.get(r.product_id) ?? {};
      entry[r.list_id] = { price: Number(r.price), manual: Boolean(r.manual) };
      result.set(r.product_id, entry);
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return result;
}

export async function savePriceList(input: { id?: string; name: string; base: PriceList["base"]; pct: number; active: boolean }): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("save_price_list", {
    p_id: input.id ?? null,
    p_name: input.name,
    p_base: input.base,
    p_pct: input.pct,
    p_active: input.active
  });
  if (error) throw error;
  return data as string;
}

export async function deletePriceList(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("delete_price_list", { p_id: id });
  if (error) throw error;
}

/** price null = vuelve a la regla de la lista. */
export async function setProductListPrices(items: { productId: string; listId: string; price: number | null }[]): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  if (items.length === 0) return;
  const { error } = await supabase.rpc("set_product_list_prices", {
    p_items: items.map((i) => ({ product_id: i.productId, list_id: i.listId, price: i.price }))
  });
  if (error) throw error;
}

export async function setCustomerPriceList(customerId: string, listId: string | null): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_customer_price_list", { p_customer_id: customerId, p_list_id: listId });
  if (error) throw error;
}

/** Botón "Mayorista" tocado a mano en Mostrador: pide el PIN de anular si la empresa tiene uno. */
export async function checkPriceListPin(pin: string | null): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: true };
  const { data, error } = await supabase.rpc("check_price_list_pin", { p_pin: pin });
  if (error) throw error;
  return data as { ok: boolean; error?: string };
}
