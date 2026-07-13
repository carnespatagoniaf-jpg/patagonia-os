import type { CartItem, PaymentMethod } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

export interface CreateSaleInput {
  branchId: string;
  paymentMethod: PaymentMethod;
  items: CartItem[];
}

export async function createSaleCloud(input: CreateSaleInput) {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const payload = input.items.map((item) => ({
    product_id: item.product.id,
    quantity: item.quantity,
    unit_price: item.unitPrice
  }));

  const { data, error } = await supabase.rpc("create_sale_transaction", {
    p_branch_id: input.branchId,
    p_payment_method: input.paymentMethod,
    p_items: payload
  });

  if (error) throw error;
  return data as { sale_id: string; total: number; profit: number };
}
