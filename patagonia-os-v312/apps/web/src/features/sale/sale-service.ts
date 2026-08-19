import { supabase } from "../../lib/supabase";

export interface CreatePosSaleInput {
  branchId: string;
  items: { productId: string; quantity: number }[];
  accountId: string;
}

export interface CreatePosSaleResult {
  saleId: string;
  total: number;
}

export async function createPosSale(input: CreatePosSaleInput): Promise<CreatePosSaleResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_pos_sale", {
    p_branch_id: input.branchId,
    p_items: input.items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
    p_account_id: input.accountId
  });
  if (error) throw error;
  return { saleId: data.sale_id, total: Number(data.total) };
}
