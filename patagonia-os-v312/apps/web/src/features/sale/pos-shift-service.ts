import { supabase } from "../../lib/supabase";

export interface PosShift {
  id: string;
  openedAt: string;
  openingCash: number;
}

export async function getOpenPosShift(branchId: string): Promise<PosShift | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("pos_shifts")
    .select("id,opened_at,opening_cash")
    .eq("branch_id", branchId)
    .eq("status", "open")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { id: data.id, openedAt: data.opened_at, openingCash: Number(data.opening_cash ?? 0) };
}

export async function openPosShift(branchId: string, openingCash = 0): Promise<PosShift> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("open_pos_shift", { p_branch_id: branchId, p_opening_cash: openingCash });
  if (error) throw error;
  return { id: data.id, openedAt: new Date().toISOString(), openingCash };
}

export interface CloseShiftAccountSummary {
  accountId: string;
  amount: number;
  salesCount: number;
}

export interface CloseShiftResult {
  total: number;
  byAccount: CloseShiftAccountSummary[];
  expectedCash: number;
  countedCash: number | null;
  difference: number | null;
}

export async function closePosShift(shiftId: string, closingCountedCash?: number): Promise<CloseShiftResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("close_pos_shift", {
    p_pos_shift_id: shiftId,
    p_closing_counted_cash: closingCountedCash ?? null
  });
  if (error) throw error;
  return {
    total: Number(data.total),
    byAccount: (data.by_account ?? []).map((row: { account_id: string; amount: number; sales_count: number }) => ({
      accountId: row.account_id,
      amount: Number(row.amount),
      salesCount: Number(row.sales_count)
    })),
    expectedCash: Number(data.expected_cash ?? 0),
    countedCash: data.counted_cash !== null && data.counted_cash !== undefined ? Number(data.counted_cash) : null,
    difference: data.difference !== null && data.difference !== undefined ? Number(data.difference) : null
  };
}

export async function voidPosSale(saleId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("void_pos_sale", { p_sale_id: saleId });
  if (error) throw error;
}

export interface PosShiftSaleItem {
  productName: string;
  quantity: number;
  unit: "kg" | "unit" | "box";
  unitPrice: number;
  discountAmount: number;
  lineTotal: number;
}

export interface PosShiftSalePayment {
  accountName: string;
  amount: number;
}

export interface PosShiftSale {
  id: string;
  createdAt: string;
  payments: PosShiftSalePayment[];
  discountAmount: number;
  surchargeAmount: number;
  total: number;
  voidedAt: string | null;
  items: PosShiftSaleItem[];
}

interface PosShiftSaleRow {
  id: string;
  created_at: string;
  discount_amount: number;
  surcharge_amount: number;
  total: number;
  voided_at: string | null;
  pos_sale_payments: { amount: number; treasury_accounts: { name: string } | null }[];
  pos_sale_items: {
    quantity: number;
    unit_price: number;
    discount_amount: number;
    line_total: number;
    description: string | null;
    products: { name: string; unit: "kg" | "unit" | "box" } | null;
  }[];
}

export async function listPosShiftSales(shiftId: string): Promise<PosShiftSale[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("pos_sales")
    .select(
      "id,created_at,discount_amount,surcharge_amount,total,voided_at," +
        "pos_sale_payments(amount,treasury_accounts(name))," +
        "pos_sale_items(quantity,unit_price,discount_amount,line_total,description,products(name,unit))"
    )
    .eq("pos_shift_id", shiftId)
    .order("created_at");

  if (error) throw error;
  return ((data ?? []) as unknown as PosShiftSaleRow[]).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    payments: row.pos_sale_payments.map((p) => ({ accountName: p.treasury_accounts?.name ?? "-", amount: Number(p.amount) })),
    discountAmount: Number(row.discount_amount),
    surchargeAmount: Number(row.surcharge_amount ?? 0),
    total: Number(row.total),
    voidedAt: row.voided_at,
    items: row.pos_sale_items.map((item) => ({
      productName: item.products?.name ?? item.description ?? "-",
      quantity: Number(item.quantity),
      unit: item.products?.unit ?? "unit",
      unitPrice: Number(item.unit_price),
      discountAmount: Number(item.discount_amount),
      lineTotal: Number(item.line_total)
    }))
  }));
}
