import type { Product } from "@patagonia/domain";
import type { SystelClient } from "./systel-client";
import { findTicketForTotal, groupTickets, parseSalesReport, ticketKey, ticketToCart, type SystelTicket, type TicketCartLine } from "./systel-sales";

/**
 * Del código del TOTAL de un ticket de Systel al detalle de ese ticket, leído de la balanza por cable
 * (función 72, solo lectura). No calcula ni supone cantidades: cada artículo sale con los gramos o
 * unidades que registró la balanza. Si algo no coincide exactamente, no carga nada y dice por qué.
 */

export type TicketDetailResult =
  | { ok: true; ticket: SystelTicket; key: string; lines: TicketCartLine[]; otherCandidates: number }
  | { ok: false; stage: "lectura" | "formato" | "ticket" | "productos"; reason: string };

export async function readTicketDetail(
  client: SystelClient,
  input: { amount: number; products: Product[]; usedKeys: string[]; now?: Date; articles?: number | null }
): Promise<TicketDetailResult> {
  const now = input.now ?? new Date();
  // Secuencia de arranque comprobada en la balanza real (ping al 1 y ping general) antes de la orden.
  await client.wake();
  const report = await client.salesReport(now);
  if ("error" in report) return { ok: false, stage: "lectura", reason: report.error };
  const parsed = parseSalesReport(report.data);
  if (!parsed.ok) return { ok: false, stage: "formato", reason: `el reporte de ventas de la balanza vino en un formato que Patagonia no reconoce: ${parsed.problem}` };
  const match = findTicketForTotal(groupTickets(parsed.lines), input.amount, { articles: input.articles ?? null, usedKeys: input.usedKeys });
  if (!match.ok) return { ok: false, stage: "ticket", reason: match.reason };
  const cart = ticketToCart(match.ticket, input.products);
  if (!cart.ok) return { ok: false, stage: "productos", reason: cart.reason };
  return { ok: true, ticket: match.ticket, key: ticketKey(match.ticket), lines: cart.lines, otherCandidates: match.otherCandidates };
}
