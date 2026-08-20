import { supabase } from "../../lib/supabase";

export interface ProductPriceRow {
  id: string;
  code: string;
  name: string;
  unit: "kg" | "unit" | "box";
  priceRetail: number;
}

/** Solo nombre/precio de venta -- nunca cost/margen, esta pantalla la ve el cajero. */
export async function listProductPrices(): Promise<ProductPriceRow[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("products")
    .select("id,code,name,unit,price_retail")
    .eq("active", true)
    .order("name");

  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    priceRetail: Number(row.price_retail)
  }));
}
