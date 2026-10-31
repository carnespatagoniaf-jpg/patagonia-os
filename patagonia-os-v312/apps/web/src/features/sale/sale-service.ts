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
  /** Código de la balanza escaneado (venta "artículos + TOTAL", migración 119); null = venta libre sin código. */
  scaleCode?: number | null;
  /** Lista de precios (Mayorista, migración 167): el servidor cobra el precio de esa lista. */
  priceListId?: string;
  /**
   * Precio que se cobró en pantalla (producto sin lista ni importe de balanza). Si el precio cambió mientras la caja
   * estaba sin internet, el servidor lo acepta cuando ese producto lo tuvo en las últimas 72 h (migración 179).
   */
  chargedUnitPrice?: number;
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
  /**
   * Papeles de la balanza de esta venta (artículos + TOTAL, migración 119). Con esto la venta va por
   * create_pos_scale_sale, que vuelve a validar todo en el servidor y no deja cobrar dos veces el mismo papel.
   * Viaja en la cola sin conexión igual que el resto.
   */
  scale?: { scaleKey: string; papers: Array<{ fingerprint: string; ticketDate: string; total: number; articles: number | null; repeatConfirmed: boolean; items: number[] }> };
}

export interface CreatePosSaleResult {
  saleId: string;
  total: number;
}

export async function createPosSale(input: CreatePosSaleInput): Promise<CreatePosSaleResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc(input.scale ? "create_pos_scale_sale" : "create_pos_sale", {
    p_branch_id: input.branchId,
    p_items: input.items.map((item) => ({
      ...(item.productId
        ? { product_id: item.productId, quantity: item.quantity, discount_amount: item.discountAmount }
        : { description: item.description, unit_price: item.unitPrice, quantity: item.quantity, discount_amount: item.discountAmount }),
      ...(item.source ? { source: item.source, scale_tickets: item.scaleTickets ?? 1 } : {}),
      ...(item.scaleAmount !== undefined && item.scaleTicket ? { scale_amount: item.scaleAmount, scale_ticket: item.scaleTicket } : {}),
      ...(item.scaleCode !== undefined ? { scale_code: item.scaleCode } : {}),
      ...(item.productId && item.priceListId ? { price_list_id: item.priceListId } : {}),
      ...(item.productId && item.chargedUnitPrice !== undefined ? { charged_unit_price: item.chargedUnitPrice } : {})
    })),
    p_payments: input.payments.map((p) => ({ account_id: p.accountId, amount: p.amount, reference: p.reference ?? null })),
    p_pos_shift_id: input.posShiftId,
    p_discount_amount: input.discountAmount,
    p_surcharge_amount: input.surchargeAmount,
    p_idempotency_key: input.idempotencyKey,
    ...(input.scale
      ? {
          p_scale_key: input.scale.scaleKey,
          p_papers: input.scale.papers.map((p) => ({ fingerprint: p.fingerprint, ticket_date: p.ticketDate, total: p.total, articles: p.articles, repeat_confirmed: p.repeatConfirmed, items: p.items }))
        }
      : {})
  });
  if (error) throw error;
  return { saleId: data.sale_id, total: Number(data.total) };
}

/**
 * Una venta guardada sin internet se subió a otro turno porque el suyo ya estaba cerrado: se anota de qué turno era
 * y a qué hora se cobró (migración 184), para explicar en Control de caja la diferencia de las dos cajas. Nunca frena
 * nada: si falla (sin conexión, base sin la 184), la venta ya está subida igual.
 */
export async function noteOfflineSaleMoved(saleId: string, originalShiftId: string, soldAt: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.rpc("note_offline_sale_moved", { p_sale_id: saleId, p_original_shift_id: originalShiftId, p_sold_at: soldAt });
  } catch {
    // solo informativo
  }
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
