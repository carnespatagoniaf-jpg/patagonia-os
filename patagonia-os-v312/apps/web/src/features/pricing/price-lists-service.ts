import { supabase } from "../../lib/supabase";
import type { PriceList } from "./price-lists";

/** La tabla/vista no existe todavía (migración 167 sin aplicar): se sigue como si no hubiera listas. */
function missingRelation(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205" || error?.code === "42703" || error?.code === "PGRST204";
}

export async function listPriceLists(): Promise<PriceList[]> {
  if (!supabase) return [];
  const first = await supabase.from("price_lists").select("id,name,base,pct,active,is_zone").order("created_at");
  let data = first.data as Array<Record<string, unknown>> | null;
  let error = first.error;
  // Base sin la migración 192 (sin is_zone): las listas de siempre, ninguna es zona.
  if (error?.code === "42703") {
    const second = await supabase.from("price_lists").select("id,name,base,pct,active").order("created_at");
    data = second.data as Array<Record<string, unknown>> | null;
    error = second.error;
  }
  if (error) {
    if (missingRelation(error)) return [];
    throw error;
  }
  return (data ?? []).map((r) => ({ id: String(r.id), name: String(r.name), base: r.base as PriceList["base"], pct: Number(r.pct), active: Boolean(r.active), isZone: r.is_zone === true }));
}

const zoneKey = (branchId: string) => `patagonia-price-zone-${branchId}`;

/** Zona de precios del local (plan Empresa, migración 192), o null = precio general. Se recuerda para Mostrador sin conexión. */
export async function getBranchZone(branchId: string): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("branches").select("price_zone_id").eq("id", branchId).maybeSingle();
  if (error) {
    if (missingRelation(error)) return null;
    try {
      return window.localStorage.getItem(zoneKey(branchId)) || null;
    } catch {
      return null;
    }
  }
  const zone = ((data as { price_zone_id?: string | null } | null)?.price_zone_id ?? null) || null;
  try {
    if (zone) window.localStorage.setItem(zoneKey(branchId), zone);
    else window.localStorage.removeItem(zoneKey(branchId));
  } catch {
    // Recordarlo es solo para cuando no hay conexión.
  }
  return zone;
}

/** Zonas y sus locales: zona → locales. */
export async function listZoneBranches(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!supabase) return out;
  const { data, error } = await supabase.from("branches").select("id,price_zone_id").eq("active", true);
  if (error) return out;
  for (const r of (data ?? []) as Array<{ id: string; price_zone_id: string | null }>) {
    if (r.price_zone_id) out.set(r.price_zone_id, [...(out.get(r.price_zone_id) ?? []), r.id]);
  }
  return out;
}

export async function savePriceZone(input: { id: string | null; name: string; pct: number; branchIds: string[] }): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("save_price_zone", { p_id: input.id, p_name: input.name, p_pct: input.pct, p_branch_ids: input.branchIds });
  if (error) throw error;
  return data as string;
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
