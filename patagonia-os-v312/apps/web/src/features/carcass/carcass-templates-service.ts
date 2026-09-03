import type { CarcassCutTemplate } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

interface CarcassCutTemplateRow {
  id: string;
  animal_type: string;
  cut_name: string;
  yield_percent: number;
  product_id: string | null;
  sort_order: number;
}

function mapTemplate(row: CarcassCutTemplateRow): CarcassCutTemplate {
  return {
    id: row.id,
    animalType: row.animal_type,
    cutName: row.cut_name,
    yieldPercent: Number(row.yield_percent),
    productId: row.product_id ?? undefined,
    sortOrder: row.sort_order
  };
}

export async function listCarcassCutTemplates(): Promise<CarcassCutTemplate[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("carcass_cut_templates")
    .select("id,animal_type,cut_name,yield_percent,product_id,sort_order")
    .order("animal_type")
    .order("sort_order");

  if (error) throw error;
  return (data ?? []).map(mapTemplate);
}

export interface SaveCarcassCutTemplateInput {
  id?: string;
  animalType: string;
  cutName: string;
  yieldPercent: number;
  productId?: string;
  sortOrder: number;
}

export async function saveCarcassCutTemplate(input: SaveCarcassCutTemplateInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("save_carcass_cut_template", {
    p_template_id: input.id ?? null,
    p_animal_type: input.animalType,
    p_cut_name: input.cutName,
    p_yield_percent: input.yieldPercent,
    p_product_id: input.productId ?? null,
    p_sort_order: input.sortOrder
  });

  if (error) throw error;
  return { id: data.id };
}

export async function deleteCarcassCutTemplate(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_carcass_cut_template", { p_template_id: id });
  if (error) throw error;
}
