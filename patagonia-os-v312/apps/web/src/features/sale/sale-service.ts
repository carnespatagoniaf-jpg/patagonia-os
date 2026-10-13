import { supabase } from "../../lib/supabase";

export interface CreatePosSaleItemInput {
  productId?: string;
  description?: string;
  unitPrice?: number;
  quantity: number;
  discountAmount: number;
  source?: "scale" | "scale_total";
  scaleTickets?: number;
  /** Importe de la balanza (ticket leído de una Systel): el servidor lo usa en vez del precio del catálogo. */
  scaleAmount?: number;
  scaleTicket?: string;
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
    p_items: input.items.map((item) => ({
      ...(item.productId
        ? { product_id: item.productId, quantity: item.quantity, discount_amount: item.discountAmount }
        : { description: item.description, unit_price: item.unitPrice, quantity: item.quantity, discount_amount: item.discountAmount }),
      ...(item.source ? { source: item.source, scale_tickets: item.scaleTickets ?? 1 } : {}),
      ...(item.scaleAmount !== undefined && item.scaleTicket ? { scale_amount: item.scaleAmount, scale_ticket: item.scaleTicket } : {})
    })),
    p_payments: input.payments.map((p) => ({ account_id: p.accountId, amount: p.amount, reference: p.reference ?? null })),
    p_pos_shift_id: input.posShiftId,
    p_discount_amount: input.discountAmount,
    p_surcharge_amount: input.surchargeAmount,
    p_idempotency_key: input.idempotencyKey
  });
  if (error) throw error;
  return { saleId: data.sale_id, total: Number(data.total) };
}

/**
 * Cuáles de estos tickets de la balanza ya están en una venta NO anulada (cualquier computadora).
 * Devuelve null si no se pudo consultar (sin conexión): entonces vale el control local de esa computadora.
 */
export async function chargedScaleTickets(keys: string[]): Promise<Set<string> | null> {
  if (!supabase) return null;
  if (keys.length === 0) return new Set();
  const { data, error } = await supabase.from("pos_sale_items").select("scale_ticket, pos_sales!inner(voided_at)").in("scale_ticket", keys).is("pos_sales.voided_at", null);
  if (error) return null;
  return new Set((data ?? []).map((r: { scale_ticket: string | null }) => r.scale_ticket).filter((k): k is string => !!k));
}
