// Vale de mercadería desde Mostrador (migración 215). Lógica pura (ver merchandise-vale.test.ts).
//
// En "Sacar plata del cajón" → "Vale a un empleado", "¿De dónde sale?" tiene la opción "Mercadería": lo que está en el
// ticket de Mostrador se lo lleva el empleado. Baja el stock, no sale plata y se le descuenta del sueldo. El precio lo calcula la base (el de la lista o la zona, como en una venta, menos el
// descuento para empleados); acá solo se arma lo que se manda y la cuenta que se muestra antes de confirmar.

import { UNIT_LABELS, type TicketLine } from "./sale-model";

export interface MerchandiseValeDone {
  employeeName: string;
  amount: number;
  discountPct: number;
  cart: TicketLine[];
}

export interface ValeItem {
  product_id: string;
  quantity: number;
  price_list_id?: string;
}

export type ValeLines = { ok: true; items: ValeItem[] } | { ok: false; problem: string };

/** Lo que se manda a la base. Solo productos: un renglón suelto o un TOTAL de balanza no dice qué mercadería es. */
export function valeItemsFromCart(cart: TicketLine[]): ValeLines {
  if (cart.length === 0) return { ok: false, problem: "Cargá en el ticket lo que se lleva el empleado." };
  const loose = cart.find((l) => l.kind !== "product" || !l.productId);
  if (loose) return { ok: false, problem: `"${loose.name}" no es un producto: en un vale solo va mercadería. Sacalo del ticket.` };
  const pending = cart.find((l) => l.scalePending);
  if (pending) return { ok: false, problem: `${pending.name} todavía espera el TOTAL de la balanza.` };
  const bad = cart.find((l) => !(l.quantity > 0) || (l.unit !== "kg" && !Number.isInteger(l.quantity)));
  if (bad) return { ok: false, problem: `Revisá la cantidad de ${bad.name}.` };
  return {
    ok: true,
    items: cart.map((l) => ({ product_id: l.productId!, quantity: Math.round(l.quantity * 1000) / 1000, ...(l.priceListId ? { price_list_id: l.priceListId } : {}) }))
  };
}

/** Cuánto se le descuenta (para mostrar antes de confirmar; el número que vale es el de la base). Redondeado al peso. */
export function valeTotal(cart: TicketLine[], discountPct: number): number {
  const pct = Math.min(Math.max(discountPct || 0, 0), 50);
  const sum = cart.reduce((s, l) => s + Math.round(l.quantity * l.unitPrice * (1 - pct / 100) * 100) / 100, 0);
  return Math.round(Math.round(sum * 1e6) / 1e6);
}

const money = (n: number) => `$${Math.round(n).toLocaleString("es-AR")}`;

/** Lo que se llevó, para el papelito que firma el empleado (el papelito ya trae la línea de firma). */
export function valeReceiptDetail(cart: TicketLine[], discountPct: number): string {
  const pct = Math.min(Math.max(discountPct || 0, 0), 50);
  const lines = cart.map((l) => {
    const qty = l.unit === "kg" ? `${l.quantity.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg` : `${l.quantity} ${UNIT_LABELS[l.unit]}`;
    return `${l.name} ${qty} ${money(l.quantity * l.unitPrice * (1 - pct / 100))}`;
  });
  return [...lines, pct > 0 ? `Con ${pct.toLocaleString("es-AR")} % de descuento para empleados.` : ""]
    .filter(Boolean)
    .join(" · ");
}
