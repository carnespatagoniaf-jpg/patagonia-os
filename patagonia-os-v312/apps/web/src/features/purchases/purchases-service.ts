import type { Purchase, PurchaseItem, SupplierPayment, PaymentMethod } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

export interface PurchaseLineInput {
  productId?: string;
  description?: string;
  quantity: number;
  unit: "kg" | "unit";
  unitPrice: number;
}

export interface CreatePurchaseInput {
  branchId: string;
  supplierId: string;
  purchaseDate: string;
  invoiceNumber?: string;
  items: PurchaseLineInput[];
}

export async function createPurchase(input: CreatePurchaseInput): Promise<{ id: string; total: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const payload = input.items.map((item) => ({
    product_id: item.productId ?? null,
    description: item.description ?? null,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unitPrice
  }));

  const { data, error } = await supabase.rpc("create_purchase_transaction", {
    p_branch_id: input.branchId,
    p_supplier_id: input.supplierId,
    p_purchase_date: input.purchaseDate,
    p_invoice_number: input.invoiceNumber ?? null,
    p_items: payload
  });

  if (error) throw error;
  return { id: data.id, total: Number(data.total) };
}

interface PurchaseRow {
  id: string;
  branch_id: string;
  supplier_id: string;
  purchase_date: string;
  invoice_number: string | null;
  total: number;
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
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

export async function listPurchasesForSupplier(supplierId: string): Promise<Purchase[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("purchases")
    .select("id,branch_id,supplier_id,purchase_date,invoice_number,total,created_by,created_at")
    .eq("supplier_id", supplierId)
    .order("purchase_date", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapPurchase);
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
    lineTotal: Number(row.line_total)
  };
}

export async function listPurchaseItems(purchaseId: string): Promise<PurchaseItem[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("purchase_items")
    .select("id,purchase_id,product_id,description,quantity,unit,unit_price,line_total")
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
  paymentMethod: PaymentMethod;
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
    p_payment_method: input.paymentMethod,
    p_notes: input.notes ?? null
  });

  if (error) throw error;
  return { id: data.id, balance: data.balance !== null && data.balance !== undefined ? Number(data.balance) : null };
}

interface SupplierPaymentRow {
  id: string;
  branch_id: string;
  supplier_id: string;
  payment_date: string;
  amount: number;
  payment_method: PaymentMethod;
  notes: string | null;
  created_at: string;
}

function mapSupplierPayment(row: SupplierPaymentRow): SupplierPayment {
  return {
    id: row.id,
    branchId: row.branch_id,
    supplierId: row.supplier_id,
    paymentDate: row.payment_date,
    amount: Number(row.amount),
    paymentMethod: row.payment_method,
    notes: row.notes ?? undefined,
    createdAt: row.created_at
  };
}

export async function listSupplierPayments(supplierId: string): Promise<SupplierPayment[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("supplier_payments")
    .select("id,branch_id,supplier_id,payment_date,amount,payment_method,notes,created_at")
    .eq("supplier_id", supplierId)
    .order("payment_date", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapSupplierPayment);
}
