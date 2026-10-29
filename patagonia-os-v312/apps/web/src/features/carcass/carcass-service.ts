import type { CarcassBatch, CarcassCut, CarcassFillSource } from "@patagonia/domain";
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
  purchase_item_id?: string | null;
  fill_source?: { kind: string; batches?: number; min?: number; max?: number } | null;
}

function mapFillSource(raw: CarcassBatchRow["fill_source"]): CarcassFillSource | undefined {
  if (raw?.kind === "learned") return { kind: "learned", batches: Number(raw.batches ?? 0), min: Number(raw.min ?? 0), max: Number(raw.max ?? 0) };
  if (raw?.kind === "template") return { kind: "template" };
  return undefined;
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
    createdAt: row.created_at,
    purchaseItemId: row.purchase_item_id ?? undefined,
    fillSource: mapFillSource(row.fill_source)
  };
}

export async function listCarcassBatches(branchId: string): Promise<CarcassBatch[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("carcass_batches")
    .select("id,branch_id,batch_date,animal_type,supplier_id,total_weight,total_cost,notes,created_at,purchase_item_id,fill_source")
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
  from_template?: boolean;
}

function mapCut(row: CarcassCutRow): CarcassCut {
  return {
    id: row.id,
    batchId: row.batch_id,
    cutName: row.cut_name,
    productId: row.product_id ?? undefined,
    weight: Number(row.weight),
    unitPrice: Number(row.unit_price),
    lineTotal: Number(row.line_total),
    fromTemplate: row.from_template ?? false
  };
}

export async function listCarcassCuts(batchId: string): Promise<CarcassCut[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("carcass_cuts")
    .select("id,batch_id,cut_name,product_id,weight,unit_price,line_total,from_template")
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


export interface CarcassBatchTotals {
  /** Lo que vale vendido (Σ kilos × precio). */
  value: number;
  weight: number;
  cuts: number;
  /** Cortes con kilos pero sin precio (no unidos a un producto de Stock). */
  unpriced: number;
  /** Cortes que repartió el sistema y nadie corrigió (0 con cortes = pesada de verdad). */
  estimated: number;
}

/** Totales de los cortes de varias reses a la vez, para la lista (ganás $… sin abrir cada una). */
export async function listCarcassBatchTotals(batchIds: string[]): Promise<Map<string, CarcassBatchTotals>> {
  const totals = new Map<string, CarcassBatchTotals>();
  if (!supabase || batchIds.length === 0) return totals;

  const { data, error } = await supabase
    .from("carcass_cuts")
    .select("batch_id,weight,unit_price,line_total,from_template")
    .in("batch_id", batchIds);

  if (error) throw error;
  for (const row of (data ?? []) as Array<{ batch_id: string; weight: number; unit_price: number; line_total: number; from_template: boolean }>) {
    const prev = totals.get(row.batch_id) ?? { value: 0, weight: 0, cuts: 0, unpriced: 0, estimated: 0 };
    const weight = Number(row.weight);
    totals.set(row.batch_id, {
      value: prev.value + Number(row.line_total),
      weight: prev.weight + weight,
      cuts: prev.cuts + 1,
      unpriced: prev.unpriced + (Number(row.unit_price) <= 0 && weight > 0 ? 1 : 0),
      estimated: prev.estimated + (row.from_template ? 1 : 0)
    });
  }
  return totals;
}

/** Reparte una res sin cortes: con el promedio de las pesadas de verdad parecidas o con los cortes de siempre (mig 163). */
export async function fillCarcassBatch(batchId: string, useDefaults: boolean): Promise<{ cuts: number; source?: CarcassFillSource }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("fill_carcass_batch", { p_batch_id: batchId, p_use_defaults: useDefaults });
  if (error) throw error;
  return { cuts: Number(data?.cuts ?? 0), source: mapFillSource(data?.source ?? null) };
}

/** "Listo, la pesé": todos los cortes de la res pasan a ser pesados de verdad. */
export async function markCarcassBatchWeighed(batchId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("mark_carcass_batch_weighed", { p_batch_id: batchId });
  if (error) throw error;
}

/** "Actualizar costos en Stock": escribe el costo por kilo de esta res en sus productos (migración 170). */
export async function applyCarcassCosts(batchId: string): Promise<{ updated: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("apply_carcass_costs", { p_batch_id: batchId });
  if (error) throw error;
  return { updated: Array.isArray(data?.updated) ? data.updated.length : 0 };
}
