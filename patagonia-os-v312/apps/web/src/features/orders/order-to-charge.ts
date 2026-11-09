// "Cobrar en Mostrador" desde un pedido (migración 196, pantalla a pedido 'pedidos_tienda'). Pedidos deja el pedido acá
// y abre Mostrador, que lo toma una sola vez, carga sus productos en el ticket y, con la venta hecha, lo marca entregado.
// Sin Supabase: puro, testeado en order-to-charge.test.ts.

import type { CustomerOrder } from "./orders-logic";

export interface OrderToCharge {
  orderId: string;
  branchId: string;
  customerName: string;
  /** Seña que ya pagó: no se descuenta (no entró al sistema); Mostrador avisa que se cobre como parte del pago. */
  deposit: number;
  items: Array<{ productId: string; productName: string; quantity: number }>;
}

export const ORDER_TO_CHARGE_KEY = "patagonia-order-to-charge";

export function orderToCharge(order: CustomerOrder): OrderToCharge {
  return {
    orderId: order.id,
    branchId: order.branchId,
    customerName: order.customerName,
    deposit: order.deposit > 0 ? order.deposit : 0,
    items: order.items.map((i) => ({ productId: i.productId, productName: i.productName, quantity: i.quantity }))
  };
}

export function saveOrderToCharge(order: OrderToCharge, storage: Pick<Storage, "setItem"> = sessionStorage): void {
  storage.setItem(ORDER_TO_CHARGE_KEY, JSON.stringify(order));
}

/** Lo saca (una sola vez) si es de esta sucursal. Si es de otra, lo deja para cuando se elija esa. */
export function takeOrderToCharge(branchId: string | null, storage: Pick<Storage, "getItem" | "removeItem"> = sessionStorage): OrderToCharge | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(ORDER_TO_CHARGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: OrderToCharge | null = null;
  try {
    parsed = JSON.parse(raw) as OrderToCharge;
  } catch {
    storage.removeItem(ORDER_TO_CHARGE_KEY);
    return null;
  }
  if (!parsed?.orderId || !Array.isArray(parsed.items)) {
    storage.removeItem(ORDER_TO_CHARGE_KEY);
    return null;
  }
  if (!branchId || parsed.branchId !== branchId) return null;
  storage.removeItem(ORDER_TO_CHARGE_KEY);
  return parsed;
}

/** Qué productos del pedido están para vender y cuáles no (dados de baja o sin stock cargado en la lista). */
export function matchOrderItems<P extends { id: string }>(order: OrderToCharge, products: P[]): { found: Array<{ product: P; quantity: number }>; missing: string[] } {
  const byId = new Map(products.map((p) => [p.id, p]));
  const found: Array<{ product: P; quantity: number }> = [];
  const missing: string[] = [];
  for (const item of order.items) {
    const product = byId.get(item.productId);
    if (product && item.quantity > 0) found.push({ product, quantity: item.quantity });
    else missing.push(item.productName);
  }
  return { found, missing };
}
