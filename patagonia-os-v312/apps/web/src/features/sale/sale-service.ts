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
  /** Cupón o número de operación -- obligatorio para cualquier medio que
   * no sea efectivo (ver 076_pos_sale_payment_reference.sql). */
  reference?: string;
}

export interface CreatePosSaleInput {
  branchId: string;
  posShiftId: string;
  items: CreatePosSaleItemInput[];
  payments: CreatePosSalePaymentInput[];
  discountAmount: number;
  surchargeAmount: number;
  /** Generado una sola vez por intento de venta (crypto.randomUUID()) y
   * reusado en cada reintento de la cola offline (ver offline-queue.ts) --
   * si el servidor ya tiene una venta con esta clave, devuelve esa misma
   * en vez de crear otra, así un reintento nunca duplica la venta. */
  idempotencyKey: string;
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
    p_payments: input.payments.map((p) => ({ account_id: p.accountId, amount: p.amount, reference: p.reference ?? null })),
    p_pos_shift_id: input.posShiftId,
    p_discount_amount: input.discountAmount,
    p_surcharge_amount: input.surchargeAmount,
    p_idempotency_key: input.idempotencyKey
  });
  if (error) throw error;
  return { saleId: data.sale_id, total: Number(data.total) };
}
