// Reportes → "Ranking de productos", "Por cajero" y "Por día y hora" (2026-10-22).
// El ranking sale de sales_by_product (114/115); cajeros y horarios de
// sales_activity_report (144). Pura, para probarla con node --test.

import { marginOnCost, type ProductSalesRow } from "./sales-by-category";

export type RankingOrder = "amount" | "profit" | "quantity";

export interface RankedProduct extends ProductSalesRow {
  profit: number;
  marginPct: number | null;
}

/**
 * Productos identificados (sin "Sin producto"), del que más al que menos según el orden pedido.
 * Por kilos solo entran los que se venden por kg (no se suman kilos con unidades).
 */
export function rankProducts(rows: ProductSalesRow[], order: RankingOrder): RankedProduct[] {
  const ranked = rows
    .filter((r) => r.productId !== null && (order !== "quantity" || r.unit === "kg"))
    .map((r) => ({ ...r, profit: Math.round((r.amount - r.cost) * 100) / 100, marginPct: marginOnCost(r.amount, r.cost) }));
  const value = (r: RankedProduct) => (order === "profit" ? r.profit : order === "quantity" ? r.quantity : r.amount);
  return ranked.sort((a, b) => value(b) - value(a) || b.amount - a.amount);
}

export interface StockedProduct {
  id: string;
  code: string;
  name: string;
  unit: "kg" | "unit" | "box";
  stock: number;
  cost: number;
  stockSourceId?: string;
}

export interface IdleProduct {
  id: string;
  code: string;
  name: string;
  unit: "kg" | "unit" | "box";
  stock: number;
  /** Plata parada: stock × costo. */
  value: number;
}

/**
 * Productos con stock que no se vendieron en el período, de mayor a menor plata parada.
 * Las presentaciones no aparecen (su stock es el del principal), y un principal
 * cuenta como vendido si se vendió cualquiera de sus presentaciones.
 */
export function idleProducts(products: StockedProduct[], sold: ProductSalesRow[]): IdleProduct[] {
  const soldIds = new Set(sold.filter((r) => r.productId !== null && r.quantity > 0).map((r) => r.productId as string));
  for (const p of products) {
    if (p.stockSourceId && soldIds.has(p.id)) soldIds.add(p.stockSourceId);
  }
  return products
    .filter((p) => !p.stockSourceId && p.stock > 0 && !soldIds.has(p.id))
    .map((p) => ({ id: p.id, code: p.code, name: p.name, unit: p.unit, stock: p.stock, value: Math.round(p.stock * Math.max(p.cost, 0) * 100) / 100 }))
    .sort((a, b) => b.value - a.value || b.stock - a.stock);
}

export interface CashierActivity {
  cashierName: string;
  withPin: boolean;
  sales: number;
  total: number;
  voidedCount: number;
  voidedAmount: number;
  discount: number;
  /** null cuando quien mira no es dueño/admin (no ve los cierres de caja). */
  shifts: number | null;
  countedShifts: number | null;
  /** Contado − esperado en los cierres: negativo = faltó plata. */
  cashDifference: number | null;
  shortShifts: number | null;
}

export interface HourActivity {
  /** 1 = lunes … 7 = domingo. */
  dow: number;
  hour: number;
  sales: number;
  total: number;
}

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function parseActivityReport(data: unknown): { cashiers: CashierActivity[]; hours: HourActivity[] } {
  const raw = (data ?? {}) as { cashiers?: Array<Record<string, unknown>>; hours?: Array<Record<string, unknown>> };
  return {
    cashiers: (raw.cashiers ?? []).map((c) => ({
      cashierName: String(c.cashier_name ?? "Sin nombre"),
      withPin: Boolean(c.with_pin),
      sales: Number(c.sales ?? 0),
      total: Number(c.total ?? 0),
      voidedCount: Number(c.voided_count ?? 0),
      voidedAmount: Number(c.voided_amount ?? 0),
      discount: Number(c.discount ?? 0),
      shifts: numOrNull(c.shifts),
      countedShifts: numOrNull(c.counted_shifts),
      cashDifference: numOrNull(c.cash_difference),
      shortShifts: numOrNull(c.short_shifts)
    })),
    hours: (raw.hours ?? []).map((h) => ({ dow: Number(h.dow), hour: Number(h.hour), sales: Number(h.sales ?? 0), total: Number(h.total ?? 0) }))
  };
}

/** Ticket promedio; 0 sin ventas. */
export function averageTicket(total: number, sales: number): number {
  return sales > 0 ? Math.round((total / sales) * 100) / 100 : 0;
}

export const DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

export interface HourGrid {
  /** Horas con alguna venta, de la primera a la última (sin huecos). */
  hours: number[];
  /** cells[dow - 1][i] = total de ese día de la semana a la hora hours[i]. */
  cells: number[][];
  max: number;
  byDay: Array<{ dow: number; sales: number; total: number }>;
  byHour: Array<{ hour: number; sales: number; total: number }>;
  bestDay: number | null;
  bestHour: number | null;
}

export function buildHourGrid(rows: HourActivity[]): HourGrid {
  const empty: HourGrid = { hours: [], cells: [], max: 0, byDay: [], byHour: [], bestDay: null, bestHour: null };
  if (rows.length === 0) return empty;
  const minHour = Math.min(...rows.map((r) => r.hour));
  const maxHour = Math.max(...rows.map((r) => r.hour));
  const hours = Array.from({ length: maxHour - minHour + 1 }, (_, i) => minHour + i);
  const cells = Array.from({ length: 7 }, () => hours.map(() => 0));
  const byDay = Array.from({ length: 7 }, (_, i) => ({ dow: i + 1, sales: 0, total: 0 }));
  const byHour = hours.map((hour) => ({ hour, sales: 0, total: 0 }));
  for (const r of rows) {
    if (r.dow < 1 || r.dow > 7) continue;
    cells[r.dow - 1][r.hour - minHour] += r.total;
    byDay[r.dow - 1].sales += r.sales;
    byDay[r.dow - 1].total += r.total;
    byHour[r.hour - minHour].sales += r.sales;
    byHour[r.hour - minHour].total += r.total;
  }
  const best = <T extends { total: number }>(list: T[]) => list.reduce<T | null>((a, b) => (b.total > 0 && (!a || b.total > a.total) ? b : a), null);
  return {
    hours,
    cells,
    max: Math.max(...cells.flat()),
    byDay,
    byHour,
    bestDay: best(byDay)?.dow ?? null,
    bestHour: best(byHour)?.hour ?? null
  };
}
