import { supabase } from "../../lib/supabase";

export interface ProductNameUnit {
  name: string;
  unit: "kg" | "unit" | "box";
}

/**
 * Nombre y unidad de varios productos, para mostrar en listas de otras tablas.
 *
 * NO embeber products(name) en un select: desde 051_hide_cost_from_cashiers.sql el rol authenticated
 * no tiene SELECT sobre products y ese embed hace fallar TODA la consulta con 403 (pasó en Mostrador,
 * Rentabilidad y, el 2026-11-02, en Pedidos: el pedido se guardaba pero la lista no cargaba nunca).
 * products_price_list es la vista habilitada para todos y no trae el costo.
 */
export async function fetchProductNames(ids: Iterable<string | null | undefined>): Promise<Map<string, ProductNameUnit>> {
  const unique = [...new Set([...ids].filter((id): id is string => !!id))];
  const byId = new Map<string, ProductNameUnit>();
  if (!supabase || unique.length === 0) return byId;
  // De a 80 ids, para no pasarse del largo de la URL.
  for (let i = 0; i < unique.length; i += 80) {
    const { data, error } = await supabase.from("products_price_list").select("id,name,unit").in("id", unique.slice(i, i + 80));
    if (error) throw error;
    for (const p of (data ?? []) as { id: string; name: string; unit: ProductNameUnit["unit"] }[]) {
      byId.set(p.id, { name: p.name, unit: p.unit });
    }
  }
  return byId;
}
