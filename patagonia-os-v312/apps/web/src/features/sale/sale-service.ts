import { supabase } from "../../lib/supabase";

export interface CreatePosSaleItemInput {
  productId?: string;
  description?: string;
  unitPrice?: number;
  quantity: number;
  discountAmount: number;
}

export interface CreatePosSalePaymentInput {
  accountId: string;
  amount: number;
}

export interface CreatePosSaleInput {
  branchId: string;
  posShiftId: string;
  items: CreatePosSaleItemInput[];
  payments: CreatePosSalePaymentInput[];
  discountAmount: number;
  surchargeAmount: number;
}

export interface CreatePosSaleResult {
  saleId: string;
  total: number;
}

export async function createPosSale(input: CreatePosSaleInput): Promise<CreatePosSaleResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_pos_sale", {
    p_branch_id: input.branchId,
    p_items: input.items.map((item) =>
      item.productId
        ? { product_id: item.productId, quantity: item.quantity, discount_amount: item.discountAmount }
        : { description: item.description, unit_price: item.unitPrice, quantity: item.quantity, discount_amount: item.discountAmount }
    ),
    p_payments: input.payments.map((p) => ({ account_id: p.accountId, amount: p.amount })),
    p_pos_shift_id: input.posShiftId,
    p_discount_amount: input.discountAmount,
    p_surcharge_amount: input.surchargeAmount
  });
  if (error) throw error;
  return { saleId: data.sale_id, total: Number(data.total) };
}
