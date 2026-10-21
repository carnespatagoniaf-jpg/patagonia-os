import type { Purchase, PurchaseItem, SupplierPayment, PaymentMethod } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

export interface PurchaseLineInput {
  productId?: string;
  description?: string;
  quantity: number;
  unit: "kg" | "unit";
  unitPrice: number;
  /** Para despostar (migración 126): crea la res en Despiece; sin producto. */
  carcassAnimalType?: string;
  /** Kilos totales cuando la línea es por unidad (ej. 4 cajones = 80 kg). */
  carcassWeight?: number;
}

export interface PurchaseCarcassResult {
  batchId: string;
  animalType: string;
  cuts: number;
}

export interface CreatePurchaseInput {
  branchId: string;
  supplierId: string;
  purchaseDate: string;
  invoiceNumber?: string;
  items: PurchaseLineInput[];
}

export async function createPurchase(input: CreatePurchaseInput): Promise<{ id: string; total: number; carcass: PurchaseCarcassResult[] }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const payload = input.items.map((item) => ({
    product_id: item.productId ?? null,
    description: item.description ?? null,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unitPrice,
    ...(item.carcassAnimalType ? { carcass_animal_type: item.carcassAnimalType, carcass_weight: item.carcassWeight ?? null } : {})
  }));

  const { data, error } = await supabase.rpc("create_purchase_transaction", {
    p_branch_id: input.branchId,
    p_supplier_id: input.supplierId,
    p_purchase_date: input.purchaseDate,
    p_invoice_number: input.invoiceNumber ?? null,
    p_items: payload
  });

  if (error) throw error;
  const carcass = ((data.carcass ?? []) as Array<{ batch_id: string; animal_type: string; cuts: number }>).map((c) => ({
    batchId: c.batch_id,
    animalType: c.animal_type,
    cuts: Number(c.cuts)
  }));
  return { id: data.id, total: Number(data.total), carcass };
}

interface PurchaseRow {
  id: string;
  branch_id: string;
  supplier_id: string;
  purchase_date: string;
  invoice_number: string | null;
  total: number;
  status: "active" | "voided";
  created_by: string;
  created_at: string;
}

function mapPurchase(row: PurchaseRow): Purchase {
  return {
    id: row.id,
    branchId: row.branch_id,
    supplierId: row.supplier_id,
    purchaseDate: row.purchase_date,
    invoiceNumber: row.invoice_number ?? undefined,
    total: Number(row.total),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

export async function listPurchasesForSupplier(supplierId: string): Promise<Purchase[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("purchases")
    .select("id,branch_id,supplier_id,purchase_date,invoice_number,total,status,created_by,created_at")
    .eq("supplier_id", supplierId)
    .order("purchase_date", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapPurchase);
}

export async function voidPurchase(purchaseId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("void_purchase", { p_purchase_id: purchaseId });
  if (error) throw error;
}

export async function updatePurchaseDate(purchaseId: string, purchaseDate: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("update_purchase_date", { p_purchase_id: purchaseId, p_purchase_date: purchaseDate });
  if (error) throw error;
}

interface PurchaseItemRow {
  id: string;
  purchase_id: string;
  product_id: string | null;
  description: string | null;
  quantity: number;
  unit: "kg" | "unit";
  unit_price: number;
  line_total: number;
  carcass_animal_type?: string | null;
  carcass_weight?: number | null;
}

function mapPurchaseItem(row: PurchaseItemRow): PurchaseItem {
  return {
    id: row.id,
    purchaseId: row.purchase_id,
    productId: row.product_id ?? undefined,
    description: row.description ?? undefined,
    quantity: Number(row.quantity),
    unit: row.unit,
    unitPrice: Number(row.unit_price),
    lineTotal: Number(row.line_total),
    carcassAnimalType: row.carcass_animal_type ?? undefined,
    carcassWeight: row.carcass_weight == null ? undefined : Number(row.carcass_weight)
  };
}

export async function listPurchaseItems(purchaseId: string): Promise<PurchaseItem[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("purchase_items")
    .select("id,purchase_id,product_id,description,quantity,unit,unit_price,line_total,carcass_animal_type,carcass_weight")
    .eq("purchase_id", purchaseId);

  if (error) throw error;
  return (data ?? []).map(mapPurchaseItem);
}

export async function updatePurchaseItem(
  itemId: string,
  quantity: number,
  unitPrice: number
): Promise<{ purchaseId: string; total: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("update_purchase_item", {
    p_item_id: itemId,
    p_quantity: quantity,
    p_unit_price: unitPrice
  });

  if (error) throw error;
  return { purchaseId: data.purchase_id, total: Number(data.total) };
}

export interface RegisterSupplierPaymentInput {
  supplierId: string;
  branchId: string;
  paymentDate: string;
  amount: number;
  accountId: string;
  notes?: string;
}

export async function registerSupplierPayment(
  input: RegisterSupplierPaymentInput
): Promise<{ id: string; balance: number | null }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("register_supplier_payment", {
    p_supplier_id: input.supplierId,
    p_branch_id: input.branchId,
    p_payment_date: input.paymentDate,
    p_amount: input.amount,
    p_account_id: input.accountId,
    p_notes: input.notes ?? null
  });

  if (error) throw error;
  return { id: data.id, balance: data.balance !== null && data.balance !== undefined ? Number(data.balance) : null };
}

export interface RegisterSupplierPaymentFromPosShiftInput {
  supplierId: string;
  posShiftId: string;
  accountId: string;
  amount: number;
  notes?: string;
}

/** Igual que registerSupplierPayment, pero ligado a un turno de Mostrador
 * (pos_shift_id) en vez de a Compras -- así el arqueo de caja del cierre
 * de turno lo tiene en cuenta como salida de efectivo. */
export async function registerSupplierPaymentFromPosShift(
  input: RegisterSupplierPaymentFromPosShiftInput
): Promise<{ id: string; balance: number | null }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("register_supplier_payment_from_pos_shift", {
    p_supplier_id: input.supplierId,
    p_pos_shift_id: input.posShiftId,
    p_account_id: input.accountId,
    p_amount: input.amount,
    p_notes: input.notes ?? null
  });

  if (error) throw error;
  return { id: data.id, balance: data.balance !== null && data.balance !== undefined ? Number(data.balance) : null };
}

export interface UpdateSupplierPaymentInput {
  id: string;
  paymentDate: string;
  amount: number;
  accountId: string;
  notes?: string;
}

export async function updateSupplierPayment(input: UpdateSupplierPaymentInput): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("update_supplier_payment", {
    p_payment_id: input.id,
    p_payment_date: input.paymentDate,
    p_amount: input.amount,
    p_account_id: input.accountId,
    p_notes: input.notes ?? null
  });
  if (error) throw error;
}

export async function deleteSupplierPayment(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_supplier_payment", { p_payment_id: id });
  if (error) throw error;
}

interface SupplierPaymentRow {
  id: string;
  branch_id: string;
  supplier_id: string;
  payment_date: string;
  amount: number;
  payment_method: PaymentMethod;
  account_id: string | null;
  treasury_accounts: { name: string } | { name: string }[] | null;
  notes: string | null;
  created_at: string;
}

function mapSupplierPayment(row: SupplierPaymentRow): SupplierPayment {
  const account = Array.isArray(row.treasury_accounts) ? row.treasury_accounts[0] : row.treasury_accounts;
  return {
    id: row.id,
    branchId: row.branch_id,
    supplierId: row.supplier_id,
    paymentDate: row.payment_date,
    amount: Number(row.amount),
    paymentMethod: row.payment_method,
    accountId: row.account_id ?? undefined,
    accountName: account?.name,
    notes: row.notes ?? undefined,
    createdAt: row.created_at
  };
}

export async function listSupplierPayments(supplierId: string): Promise<SupplierPayment[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("supplier_payments")
    .select("id,branch_id,supplier_id,payment_date,amount,payment_method,account_id,notes,created_at,treasury_accounts(name)")
    .eq("supplier_id", supplierId)
    .order("payment_date", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapSupplierPayment);
}

/**
 * Descuentos y recargos en la cuenta del proveedor (migración 142). Solo para
 * empresas con companies.supplier_adjustments (hoy Martínez). amount > 0 =
 * recargo (se le debe más), amount < 0 = descuento. No mueve caja ni stock.
 */
export interface SupplierAdjustment {
  id: string;
  supplierId: string;
  adjustmentDate: string;
  amount: number;
  notes?: string;
}

export async function fetchSupplierAdjustmentsEnabled(companyId: string): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.from("companies").select("supplier_adjustments").eq("id", companyId).maybeSingle();
  // Base sin la migración 142: la función queda apagada, nunca rompe Compras.
  if (error || !data) return false;
  return Boolean((data as { supplier_adjustments?: boolean }).supplier_adjustments);
}

export async function listSupplierAdjustments(supplierId: string): Promise<SupplierAdjustment[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("supplier_adjustments")
    .select("id,supplier_id,adjustment_date,amount,notes")
    .eq("supplier_id", supplierId)
    .order("adjustment_date", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    supplierId: row.supplier_id as string,
    adjustmentDate: row.adjustment_date as string,
    amount: Number(row.amount),
    notes: (row.notes as string | null) ?? undefined
  }));
}

export async function addSupplierAdjustment(input: { supplierId: string; adjustmentDate: string; amount: number; notes?: string }): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("add_supplier_adjustment", {
    p_supplier_id: input.supplierId,
    p_adjustment_date: input.adjustmentDate,
    p_amount: input.amount,
    p_notes: input.notes ?? null
  });
  if (error) throw error;
}

export async function deleteSupplierAdjustment(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("delete_supplier_adjustment", { p_adjustment_id: id });
  if (error) throw error;
}
