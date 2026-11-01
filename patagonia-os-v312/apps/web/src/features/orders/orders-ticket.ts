import { TicketBuilder, getThermalPrintSettings } from "../sale/thermal-printer";
import { formatMoney } from "../shifts/format";
import { balanceDue, dayLabel, itemLabel, type CustomerOrder } from "./orders-logic";

/** Papelito del pedido para la térmica (mismo armado que los tickets de Mostrador, sale-tickets.ts). */
export function buildOrderTicket(order: CustomerOrder, branchName?: string): Uint8Array {
  const settings = getThermalPrintSettings();
  const t = new TicketBuilder();
  if (settings.font !== "auto") t.font(settings.font);
  t.bodySize(settings, true);
  t.align("center");
  if (branchName) t.line(branchName);
  t.bold(true).line("PEDIDO PARA RETIRAR").bold(false);
  t.separator("-", settings.lineWidth);
  t.bodySize(settings, false);
  t.bold(true).doubleSize(true).line(dayLabel(order.pickupDate).toUpperCase());
  if (order.pickupTime) t.line(`${order.pickupTime} hs`);
  t.doubleSize(false).bold(false);
  t.bodySize(settings, true);
  t.align("left").separator("-", settings.lineWidth);
  t.bold(true).line(order.customerName).bold(false);
  if (order.customerPhone) t.line(`Tel: ${order.customerPhone}`);
  t.separator("-", settings.lineWidth);
  for (const item of order.items) {
    t.line(itemLabel(item));
    if (item.notes) t.line(`   ${item.notes}`);
  }
  if (order.notes) {
    t.separator("-", settings.lineWidth);
    t.line(`Nota: ${order.notes}`);
  }
  if (order.total !== null || order.deposit > 0) {
    t.separator("-", settings.lineWidth);
    if (order.total !== null) t.line(`Total: ${formatMoney(order.total)}`);
    t.line(`Seña: ${formatMoney(order.deposit)}`);
    const due = balanceDue(order);
    if (due !== null) {
      t.bodySize(settings, false);
      t.bold(true).doubleSize(true).line(`A COBRAR ${formatMoney(due)}`).doubleSize(false).bold(false);
      t.bodySize(settings, true);
    }
  }
  t.separator("-", settings.lineWidth);
  t.align("center").line("Pedido guardado en el sistema");
  t.bodySize(settings, false);
  t.cut();
  return t.build();
}
