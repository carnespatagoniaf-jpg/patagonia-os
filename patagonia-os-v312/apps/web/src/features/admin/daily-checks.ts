import type { DailyCheck } from "./admin-service";

/** Qué decirle a Patagonia de un cliente, en palabras (vacío = está todo bien). Lógica pura, testeada. */
export function dailyCheckIssues(c: DailyCheck, now = Date.now()): string[] {
  const issues: string[] = [];
  if (c.products === 0) issues.push("No cargó ningún producto");
  else if (!c.lastSaleAt) issues.push("Nunca vendió por Mostrador");
  else {
    const days = Math.floor((now - new Date(c.lastSaleAt).getTime()) / 86_400_000);
    if (days >= 7) issues.push(`No vende por Mostrador hace ${days} días`);
  }
  if (c.openShiftsOld > 0) {
    const days = c.oldestOpenShift ? Math.max(1, Math.floor((now - new Date(c.oldestOpenShift).getTime()) / 86_400_000)) : 1;
    issues.push(c.openShiftsOld === 1 ? `Caja abierta hace ${days} día${days === 1 ? "" : "s"}` : `${c.openShiftsOld} cajas abiertas (la más vieja, hace ${days} días)`);
  }
  if (c.stuckInvoices > 0) issues.push(`${c.stuckInvoices} factura${c.stuckInvoices === 1 ? "" : "s"} trabada${c.stuckInvoices === 1 ? "" : "s"} en ARCA`);
  if (c.belowCost > 0) issues.push(`${c.belowCost} producto${c.belowCost === 1 ? "" : "s"} con precio menor al costo`);
  if (c.negativeStock > 0) issues.push(`${c.negativeStock} producto${c.negativeStock === 1 ? "" : "s"} con stock negativo`);
  return issues;
}
