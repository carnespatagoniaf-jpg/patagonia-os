/**
 * "Hoy en tus locales" (Inicio, dueño/administrador, migración 186): cómo está cada sucursal hoy, en frases cortas
 * para leer en el celular. Lógica pura, testeada (owner-today.test.ts).
 */

export interface OwnerTodayRow {
  branchId: string;
  branchName: string;
  isVehicle: boolean;
  salesTotal: number;
  salesCount: number;
  lastSaleAt: string | null;
  voidedCount: number;
  voidedTotal: number;
  openSince: string | null;
  openCashier: string | null;
  closesToday: number;
  closeDifference: number | null;
}

export type Tone = "ok" | "warn" | "bad" | "muted";

export interface OwnerTodayLine {
  text: string;
  tone: Tone;
}

/** Igual que el cierre de caja: hasta $500 de diferencia "dio bien" (cash-close.ts). */
const TOLERANCE = 500;
/** Una caja abierta hace más de esto casi seguro quedó sin cerrar (mismo aviso que Mostrador). */
const STALE_HOURS = 20;

const money = (n: number) => `$${Math.round(n).toLocaleString("es-AR")}`;
const hour = (iso: string) => new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
const day = (iso: string) => new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });

export function ownerTodayLines(r: OwnerTodayRow, now = new Date()): OwnerTodayLine[] {
  const lines: OwnerTodayLine[] = [];

  if (r.openSince) {
    const hours = (now.getTime() - new Date(r.openSince).getTime()) / 3_600_000;
    const who = r.openCashier ? ` · ${r.openCashier}` : "";
    lines.push(
      hours > STALE_HOURS
        ? { text: `Caja abierta desde el ${day(r.openSince)}${who}: no se cerró`, tone: "bad" }
        : { text: `Caja abierta desde las ${hour(r.openSince)}${who}`, tone: "ok" }
    );
  } else if (r.closesToday === 0) {
    lines.push({ text: r.salesCount > 0 ? "Caja cerrada" : "No abrió la caja hoy", tone: "muted" });
  }

  if (r.closesToday > 0) {
    const d = r.closeDifference ?? 0;
    const label = r.closesToday === 1 ? "Cierre de hoy" : `${r.closesToday} cierres de hoy`;
    if (Math.abs(d) <= TOLERANCE) lines.push({ text: `${label}: dio bien`, tone: "ok" });
    else if (d < 0) lines.push({ text: `${label}: faltaron ${money(-d)}`, tone: "bad" });
    else lines.push({ text: `${label}: sobraron ${money(d)}`, tone: "warn" });
  }

  if (r.voidedCount > 0) {
    lines.push({ text: `${r.voidedCount === 1 ? "1 venta anulada" : `${r.voidedCount} ventas anuladas`} (${money(r.voidedTotal)})`, tone: "warn" });
  }

  if (r.lastSaleAt) lines.push({ text: `Última venta ${hour(r.lastSaleAt)}`, tone: "muted" });
  return lines;
}

/** Sucursales que vale la pena mostrar: con algo hoy, o que no son camiones. */
export function visibleBranches(rows: OwnerTodayRow[]): OwnerTodayRow[] {
  return rows.filter((r) => !r.isVehicle || r.salesCount > 0 || r.openSince || r.closesToday > 0);
}

export function ownerTodayTotal(rows: OwnerTodayRow[]): { total: number; count: number } {
  return rows.reduce((acc, r) => ({ total: acc.total + r.salesTotal, count: acc.count + r.salesCount }), { total: 0, count: 0 });
}
