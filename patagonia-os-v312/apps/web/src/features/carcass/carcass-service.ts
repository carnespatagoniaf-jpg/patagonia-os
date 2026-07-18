import type { CarcassBatch, CarcassCut } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

interface CarcassBatchRow {
  id: string;
  branch_id: string;
  batch_date: string;
  animal_type: string;
  supplier_id: string | null;
  total_weight: number;
  total_cost: number;
  notes: string | null;
  created_at: string;
}

function mapBatch(row: CarcassBatchRow): CarcassBatch {
  return {
    id: row.id,
    branchId: row.branch_id,
    batchDate: row.batch_date,
    animalType: row.animal_type,
    supplierId: row.supplier_id ?? undefined,
    totalWeight: Number(row.total_weight),
    totalCost: Number(row.total_cost),
    notes: row.notes ?? undefined,
    createdAt: row.created_at
  };
}

export async function listCarcassBatches(branchId: string): Promise<CarcassBatch[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("carcass_batches")
    .select("id,branch_id,batch_date,animal_type,supplier_id,total_weight,total_cost,notes,created_at")
    .eq("branch_id", branchId)
    .order("batch_date", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapBatch);
}

export interface SaveCarcassBatchInput {
  id?: string;
  branchId: string;
  batchDate: string;
  animalType: string;
  supplierId?: string;
  totalWeight: number;
  totalCost: number;
  notes?: string;
}

export async function saveCarcassBatch(input: SaveCarcassBatchInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("save_carcass_batch", {
    p_batch_id: input.id ?? null,
    p_branch_id: input.branchId,
    p_batch_date: input.batchDate,
    p_animal_type: input.animalType,
    p_supplier_id: input.supplierId ?? null,
    p_total_weight: input.totalWeight,
    p_total_cost: input.totalCost,
    p_notes: input.notes ?? null
  });

  if (error) throw error;
  return { id: data.id };
}

export async function deleteCarcassBatch(batchId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_carcass_batch", { p_batch_id: batchId });
  if (error) throw error;
}

interface CarcassCutRow {
  id: string;
  batch_id: string;
  cut_name: string;
  product_id: string | null;
  weight: number;
  unit_price: number;
  line_total: number;
}

function mapCut(row: CarcassCutRow): CarcassCut {
  return {
    id: row.id,
    batchId: row.batch_id,
    cutName: row.cut_name,
    productId: row.product_id ?? undefined,
    weight: Number(row.weight),
    unitPrice: Number(row.unit_price),
    lineTotal: Number(row.line_total)
  };
}

export async function listCarcassCuts(batchId: string): Promise<CarcassCut[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("carcass_cuts")
    .select("id,batch_id,cut_name,product_id,weight,unit_price,line_total")
    .eq("batch_id", batchId)
    .order("line_total", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapCut);
}

export interface SaveCarcassCutInput {
  id?: string;
  batchId: string;
  cutName: string;
  productId?: string;
  weight: number;
  unitPrice: number;
}

export async function saveCarcassCut(input: SaveCarcassCutInput): Promise<{ id: string; lineTotal: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("save_carcass_cut", {
    p_cut_id: input.id ?? null,
    p_batch_id: input.batchId,
    p_cut_name: input.cutName,
    p_product_id: input.productId ?? null,
    p_weight: input.weight,
    p_unit_price: input.unitPrice
  });

  if (error) throw error;
  return { id: data.id, lineTotal: Number(data.line_total) };
}

export async function deleteCarcassCut(cutId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_carcass_cut", { p_cut_id: cutId });
  if (error) throw error;
}
