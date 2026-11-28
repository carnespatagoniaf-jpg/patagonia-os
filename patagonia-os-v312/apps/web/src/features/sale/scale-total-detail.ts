import type { Product } from "@patagonia/domain";
import { formatMoney } from "../shifts/format";
import type { TicketLine } from "./sale-model";
import { detailedTotalKey } from "./scale-repeat";
import { addDetailLine } from "./ticket-detail";

/**
 * TOTAL de la balanza (Kretz Aura "998"/"99998", Kretz "0000…") — C7, decisión del dueño 26/11: "no quiero ventas con
 * diferencias de stock ni cobros ambiguos". Reemplaza a "se cobra el TOTAL directo" (a9ef0f8, 15/10).
 *
 * - Un TOTAL escaneado SOLO no se cobra. Entra como "Ticket de balanza — falta detallar" (source 'scale_total') y
 *   Mostrador no deja cobrar mientras haya uno (`pendingTotals`). Se detalla escaneando la etiqueta de cada producto de
 *   ese ticket, o eligiendo el producto y escribiendo el importe del papel (ticket-detail.ts). Cuando la suma da el
 *   TOTAL, la línea del TOTAL sale y quedan los productos con su importe (bajan stock).
 * - Si las etiquetas de los productos ya están en la venta y suman EXACTO el TOTAL, el TOTAL solo confirma: no se
 *   agrega otra línea (antes se preguntaba y se podía cobrar dos veces).
 * - Control de cierre de balanza (migraciones 104/134): el ticket cuenta UNA vez. Las líneas del detalle o confirmadas
 *   van con scale_tickets 0 salvo la primera (1); la suma de sus importes es el TOTAL.
 *
 * Puro, sin pantallas ni conexión: funciona igual sin internet.
 */

export const TOTAL_LINE_NAME = "Ticket de balanza (falta detallar)";

const round2 = (n: number) => Math.round(n * 100) / 100;
const lineAmount = (l: TicketLine) => round2(l.scaleAmount ?? l.quantity * l.unitPrice);

/** TOTALES de la balanza todavía sin detallar: con alguno, la venta no se cobra. */
export function pendingTotals(cart: TicketLine[]): TicketLine[] {
  return cart.filter((l) => l.source === "scale_total");
}

export const PENDING_TOTAL_MESSAGE =
  "Hay un TOTAL de la balanza sin detallar: escaneá la etiqueta de cada producto de ese ticket (o buscalo y escribí su importe) hasta que dé el TOTAL, o sacalo de la venta. Así no se cobra sin bajar el stock.";

/**
 * Etiquetas de la balanza leídas con el formato de la sucursal (resolveScan) que todavía no son parte de un ticket:
 * las de peso (clave "<producto>|scale") y las de importe (scaleTicket "<código>@<hora>"). No cuentan las de una Systel
 * (tienen su propio TOTAL) ni lo buscado a mano.
 */
function looseLabels(cart: TicketLine[]): TicketLine[] {
  return cart.filter((l) => l.kind === "product" && l.source === "scale" && !l.detailOf && (l.key.endsWith("|scale") || /@\d+$/.test(l.scaleTicket ?? "")));
}

export type TotalScan =
  | { kind: "detail"; cart: TicketLine[]; message: string }
  | { kind: "confirmed"; cart: TicketLine[]; message: string }
  | { kind: "mismatch"; message: string }
  | { kind: "duplicate"; message: string };

export function scanTotal(cart: TicketLine[], key: string, amount: number): TotalScan {
  if (cart.some((l) => l.key === key || l.detailOf === key)) return { kind: "duplicate", message: "Ese ticket de la balanza ya está en esta venta." };
  const labels = looseLabels(cart);
  if (labels.length > 0) {
    const labelsSum = round2(labels.reduce((s, l) => s + lineAmount(l), 0));
    if (Math.abs(labelsSum - amount) >= 0.005) {
      return {
        kind: "mismatch",
        message: `No se agregó el TOTAL: los productos de la balanza que ya están en esta venta suman ${formatMoney(labelsSum)} y el TOTAL es ${formatMoney(amount)}. Si son de este ticket, revisá que estén todos (y ninguno de otro ticket) y volvé a escanear el TOTAL. Si el TOTAL es de otro ticket, cobrá primero esta venta y escanealo en una venta nueva.`
      };
    }
    // Las etiquetas son el detalle de este TOTAL: quedan como un ticket (juntas, y cuentan una sola vez).
    const ids = new Set(labels.map((l) => l.key));
    // Una etiqueta de importe lleva la identidad del TOTAL ("<clave>#1", como un ticket detallado): así, si ese mismo
    // papel se vuelve a escanear en otra venta, Mostrador avisa que ya se cobró (chargedScaleTickets).
    const carrier = labels.find((l) => l.scaleTicket && l.scaleAmount !== undefined)?.key;
    let first = true;
    const next = cart.map((l) => {
      if (!ids.has(l.key)) return l;
      const tickets = first ? 1 : 0;
      first = false;
      return { ...l, key: `${l.key}|total:${key}`, detailOf: key, scaleTickets: tickets, ...(l.key === carrier ? { scaleTicket: detailedTotalKey(key) } : {}) };
    });
    return { kind: "confirmed", cart: next, message: `TOTAL confirmado: ${formatMoney(amount)} = los ${labels.length} producto${labels.length === 1 ? "" : "s"} de la balanza ya cargados. No se agregó nada más.` };
  }
  const line: TicketLine = { key, kind: "manual", name: TOTAL_LINE_NAME, unit: "unit", quantity: 1, unitPrice: amount, source: "scale_total", scaleTickets: 1 };
  return {
    kind: "detail",
    cart: [...cart, line],
    message: `Detallá el ticket de ${formatMoney(amount)}: escaneá la etiqueta de cada producto, o buscá cada producto y escribí el importe del papel. Recién cuando dé el TOTAL se puede cobrar.`
  };
}

/**
 * Un producto del ticket que se está detallando. `quantity`: los kilos o unidades de su etiqueta (null = salen del
 * importe ÷ precio con el que imprimió la balanza, como las etiquetas de importe). `amount`: el importe del papel.
 */
export function addDetailScan(cart: TicketLine[], totalKey: string, product: Pick<Product, "id" | "name" | "unit" | "priceRetail">, quantity: number | null, amount: number) {
  const r = addDetailLine(cart, totalKey, product, amount);
  if (!r.ok || quantity === null || !(quantity > 0)) return r;
  const lineAmt = r.line.scaleAmount ?? amount;
  const line: TicketLine = { ...r.line, quantity, unitPrice: lineAmt / quantity };
  return { ...r, line, cart: r.cart.map((l) => (l.key === r.line.key ? { ...l, quantity, unitPrice: lineAmt / quantity } : l)) };
}
