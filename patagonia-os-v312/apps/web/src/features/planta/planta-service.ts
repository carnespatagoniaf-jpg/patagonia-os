import { supabase } from "../../lib/supabase";
import { normalizePackageCode, type PackageStatus, type PlantaPackage } from "./planta-logic";

// Planta (migración 194, plan Planta). Los paquetes se leen directo de la tabla (RLS: empresa + plan Planta) y se
// escriben solo por RPC (migración 175). Sin la migración, la web sigue andando: listas vacías.

interface PackageRow {
  id: string;
  number: number;
  code: string;
  product_id: string;
  origin_branch_id: string;
  branch_id: string;
  carcass_batch_id: string | null;
  quantity: number | string;
  packed_on: string;
  expires_on: string | null;
  status: PackageStatus;
  transfer_id: string | null;
  pos_sale_id: string | null;
  sold_at: string | null;
  void_reason: string | null;
}

const COLUMNS = "id,number,code,product_id,origin_branch_id,branch_id,carcass_batch_id,quantity,packed_on,expires_on,status,transfer_id,pos_sale_id,sold_at,void_reason";

function missingTable(error: { code?: string } | null): boolean {
  return !!error && (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST200");
}

function mapPackage(r: PackageRow): PlantaPackage {
  return {
    id: r.id,
    number: r.number,
    code: r.code,
    productId: r.product_id,
    originBranchId: r.origin_branch_id,
    branchId: r.branch_id,
    carcassBatchId: r.carcass_batch_id,
    quantity: Number(r.quantity),
    packedOn: r.packed_on,
    expiresOn: r.expires_on,
    status: r.status,
    transferId: r.transfer_id,
    posSaleId: r.pos_sale_id,
    soldAt: r.sold_at,
    voidReason: r.void_reason
  };
}

/** Paquetes de un local: los que están (planta, viaje, local) y los vendidos o anulados de los últimos 30 días. */
export async function listBranchPackages(branchId: string): Promise<PlantaPackage[]> {
  if (!supabase) return [];
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("planta_packages")
    .select(COLUMNS)
    .eq("branch_id", branchId)
    .or(`status.in.(en_planta,en_viaje,en_local),updated_at.gte.${since}`)
    .order("number", { ascending: false })
    .limit(5000);
  if (missingTable(error)) return [];
  if (error) throw error;
  return ((data ?? []) as PackageRow[]).map(mapPackage);
}

/** Un paquete por su código (Mostrador y el envío escaneando). */
export async function findPackage(code: string): Promise<PlantaPackage | undefined> {
  if (!supabase) return undefined;
  const { data, error } = await supabase.from("planta_packages").select(COLUMNS).eq("code", normalizePackageCode(code)).maybeSingle();
  if (missingTable(error)) return undefined;
  if (error) throw error;
  return data ? mapPackage(data as PackageRow) : undefined;
}

export interface PackedPackage {
  id: string;
  number: number;
  code: string;
  quantity: number;
}

export async function packProduct(input: {
  branchId: string;
  productId: string;
  quantities: number[];
  carcassBatchId: string | null;
  expiresOn: string | null;
}): Promise<PackedPackage[]> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("planta_pack", {
    p_branch_id: input.branchId,
    p_product_id: input.productId,
    p_quantities: input.quantities,
    p_carcass_batch_id: input.carcassBatchId,
    p_expires_on: input.expiresOn
  });
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; number: number; code: string; quantity: number | string }>).map((p) => ({ ...p, quantity: Number(p.quantity) }));
}

export async function voidPackage(id: string, reason: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("planta_void_package", { p_id: id, p_reason: reason });
  if (error) throw error;
}

export async function shipPackages(input: {
  fromBranchId: string;
  toBranchId: string;
  codes: string[];
  carrier: string;
  vehicle: string;
  notes: string;
}): Promise<{ id: string; number: number; packages: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("planta_ship", {
    p_from: input.fromBranchId,
    p_to: input.toBranchId,
    p_codes: input.codes,
    p_carrier: input.carrier.trim() || null,
    p_vehicle: input.vehicle.trim() || null,
    p_notes: input.notes.trim() || null
  });
  if (error) throw error;
  const r = data as { id: string; number: number; packages: number };
  return { id: r.id, number: Number(r.number), packages: Number(r.packages) };
}
