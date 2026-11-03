import { supabase } from "../../lib/supabase";
import { fetchProductNames } from "../products/product-names";
import type { Transfer, TransferStatus, TransferUnit } from "./transfer-logic";

// Mercadería entre locales (migración 190, plan Empresa). Se lee directo de las tablas (RLS: empresa + plan)
// y se escribe solo por RPC (migración 175). Sin la migración, la web sigue andando: listas vacías.

interface TransferRow {
  id: string;
  number: number;
  from_branch_id: string;
  to_branch_id: string;
  status: TransferStatus;
  needed_by: string | null;
  request_notes: string | null;
  carrier: string | null;
  vehicle: string | null;
  show_cost: boolean;
  remito_id: string | null;
  requested_at: string | null;
  dispatched_at: string | null;
  received_at: string | null;
  received_by_name: string | null;
  receive_notes: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  branch_transfer_items: Array<{
    id: string;
    product_id: string;
    requested_qty: number | string | null;
    sent_qty: number | string | null;
    received_qty: number | string | null;
    unit_cost: number | string | null;
    position: number;
  }> | null;
}

const num = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));

function missingTable(error: { code?: string } | null): boolean {
  return !!error && (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST200");
}

export interface TransferBranch {
  id: string;
  name: string;
}

/** Locales que mandan y reciben mercadería (los camiones se cargan desde Camiones). */
export async function listTransferBranches(): Promise<TransferBranch[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("branches").select("id,name,is_vehicle").eq("active", true).order("name");
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; name: string; is_vehicle: boolean | null }>).filter((b) => !b.is_vehicle).map((b) => ({ id: b.id, name: b.name }));
}

/** Pedidos y envíos: los que siguen abiertos y los de los últimos 60 días. */
export async function listTransfers(): Promise<Transfer[]> {
  if (!supabase) return [];
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("branch_transfers")
    .select(
      "id,number,from_branch_id,to_branch_id,status,needed_by,request_notes,carrier,vehicle,show_cost,remito_id,requested_at,dispatched_at,received_at,received_by_name,receive_notes,cancelled_at,cancel_reason,created_at,branch_transfer_items(id,product_id,requested_qty,sent_qty,received_qty,unit_cost,position)"
    )
    .or(`status.in.(pedido,preparando,en_viaje),created_at.gte.${since}`)
    .order("created_at", { ascending: false })
    .limit(400);
  if (missingTable(error)) return [];
  if (error) throw error;
  const rows = (data ?? []) as TransferRow[];
  const names = await fetchProductNames(rows.flatMap((r) => (r.branch_transfer_items ?? []).map((i) => i.product_id)));
  const codes = await fetchProductCodes(rows.flatMap((r) => (r.branch_transfer_items ?? []).map((i) => i.product_id)));
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    fromBranchId: r.from_branch_id,
    toBranchId: r.to_branch_id,
    status: r.status,
    neededBy: r.needed_by,
    requestNotes: r.request_notes,
    carrier: r.carrier,
    vehicle: r.vehicle,
    showCost: r.show_cost,
    remitoId: r.remito_id,
    requestedAt: r.requested_at,
    dispatchedAt: r.dispatched_at,
    receivedAt: r.received_at,
    receivedByName: r.received_by_name,
    receiveNotes: r.receive_notes,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
    items: [...(r.branch_transfer_items ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((i) => ({
        id: i.id,
        productId: i.product_id,
        name: names.get(i.product_id)?.name ?? "Producto",
        code: codes.get(i.product_id) ?? null,
        unit: (names.get(i.product_id)?.unit ?? "kg") as TransferUnit,
        requested: num(i.requested_qty),
        sent: num(i.sent_qty),
        received: num(i.received_qty),
        unitCost: num(i.unit_cost)
      }))
  }));
}

/** Código de cada producto (products_price_list, sin costo: la ven todos los papeles). */
async function fetchProductCodes(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, string>();
  if (!supabase || unique.length === 0) return out;
  for (let i = 0; i < unique.length; i += 80) {
    const { data, error } = await supabase.from("products_price_list").select("id,code").in("id", unique.slice(i, i + 80));
    if (error) throw error;
    for (const p of (data ?? []) as Array<{ id: string; code: string | null }>) if (p.code) out.set(p.id, p.code);
  }
  return out;
}

export interface QtyLine {
  productId: string;
  quantity: number;
}

const items = (lines: QtyLine[]) => lines.map((l) => ({ product_id: l.productId, quantity: l.quantity }));

export async function requestTransfer(input: { fromBranchId: string; toBranchId: string; neededBy: string | null; notes: string; lines: QtyLine[] }): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("request_branch_transfer", {
    p_from: input.fromBranchId,
    p_to: input.toBranchId,
    p_needed_by: input.neededBy,
    p_notes: input.notes,
    p_items: items(input.lines)
  });
  if (error) throw error;
  return data as string;
}

export interface PrepareInput {
  /** null = envío sin pedido. */
  id: string | null;
  fromBranchId: string | null;
  toBranchId: string | null;
  lines: QtyLine[];
  carrier: string;
  vehicle: string;
  notes: string;
}

export async function prepareTransfer(input: PrepareInput): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("prepare_branch_transfer", {
    p_id: input.id,
    p_from: input.fromBranchId,
    p_to: input.toBranchId,
    p_items: items(input.lines),
    p_carrier: input.carrier,
    p_vehicle: input.vehicle,
    p_notes: input.notes
  });
  if (error) throw error;
  return data as string;
}

export async function dispatchTransfer(
  input: PrepareInput & { remitoR: boolean; showCost: boolean; deliveryAddress: string }
): Promise<{ id: string; number: number; remitoId: string | null }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("dispatch_branch_transfer", {
    p_id: input.id,
    p_from: input.fromBranchId,
    p_to: input.toBranchId,
    p_items: items(input.lines),
    p_carrier: input.carrier,
    p_vehicle: input.vehicle,
    p_notes: input.notes,
    p_remito_r: input.remitoR,
    p_show_cost: input.showCost,
    p_delivery_address: input.deliveryAddress
  });
  if (error) throw error;
  const r = data as { id: string; number: number; remito_id: string | null };
  return { id: r.id, number: Number(r.number), remitoId: r.remito_id };
}

export async function receiveTransfer(input: { id: string; received: Array<{ itemId: string; received: number }>; receivedByName: string; notes: string }): Promise<{ missing: number; extra: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("receive_branch_transfer", {
    p_id: input.id,
    p_items: input.received.map((r) => ({ item_id: r.itemId, received: r.received })),
    p_received_by_name: input.receivedByName,
    p_notes: input.notes
  });
  if (error) throw error;
  const r = data as { missing: number | string; extra: number | string };
  return { missing: Number(r.missing), extra: Number(r.extra) };
}

export async function cancelTransfer(id: string, reason: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("cancel_branch_transfer", { p_id: id, p_reason: reason });
  if (error) throw error;
}

export async function voidTransfer(id: string, reason: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("void_branch_transfer", { p_id: id, p_reason: reason });
  if (error) throw error;
}

/** Mínimo de cada local: branchId → (productId → mínimo). */
export async function listBranchMinStock(): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!supabase) return out;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("branch_min_stock").select("branch_id,product_id,min_stock").order("branch_id").order("product_id").range(from, from + PAGE - 1);
    if (missingTable(error)) return out;
    if (error) throw error;
    const rows = (data ?? []) as Array<{ branch_id: string; product_id: string; min_stock: number | string }>;
    for (const r of rows) {
      const m = out.get(r.branch_id) ?? new Map<string, number>();
      m.set(r.product_id, Number(r.min_stock));
      out.set(r.branch_id, m);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/** minStock null o 0 = sin mínimo propio del local. */
export async function setBranchMinStock(branchId: string, lines: Array<{ productId: string; minStock: number | null }>): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_branch_min_stock", {
    p_branch_id: branchId,
    p_items: lines.map((l) => ({ product_id: l.productId, min_stock: l.minStock }))
  });
  if (error) throw error;
}
