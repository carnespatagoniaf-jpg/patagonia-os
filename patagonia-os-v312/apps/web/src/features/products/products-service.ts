import { supabase } from "../../lib/supabase";

export interface ProductPriceRow {
  id: string;
  code: string;
  name: string;
  unit: "kg" | "unit" | "box";
  priceRetail: number;
}

/** Orden numérico por código cuando los dos son puramente numéricos (ej.
 * "2" antes que "10" -- un orden de texto normal pondría "10" primero);
 * si alguno no lo es (ej. "VAC-001"), cae a orden alfabético normal. */
export function compareByCode(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/** Solo nombre/precio de venta -- nunca cost/margen, esta pantalla la ve el cajero. */
export async function listProductPrices(): Promise<ProductPriceRow[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("products_price_list")
    .select("id,code,name,unit,price_retail")
    .eq("active", true);

  if (error) throw error;
  return (data ?? [])
    .map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      unit: row.unit,
      priceRetail: Number(row.price_retail)
    }))
    .sort((a, b) => compareByCode(a.code, b.code));
}
