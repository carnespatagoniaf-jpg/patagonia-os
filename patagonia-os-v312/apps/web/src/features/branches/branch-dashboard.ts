/**
 * Tablero de sucursales (2026-11-02, el dueño: "pensá en un sistema como una empresa importante, alguien con 6 locales").
 * Junta, local por local, lo que ya calculan Reportes y Rentabilidad (period_result_report, sales_activity_report,
 * sales_by_product) y arma el ranking, el total y las alertas. Sin base nueva: todo sale de lo que ya se carga.
 */
export interface BranchStats {
  branchId: string;
  branchName: string;
  /** Ventas del período (Mostrador + a cuenta + Turnos). */
  sales: number;
  prevSales: number | null;
  grossProfit: number;
  /** Ganancia bruta − gastos − sueldos − mermas (igual que Reportes → Resultado). */
  result: number;
  /** Ventas de Mostrador (para el ticket promedio). */
  posSales: number;
  posTotal: number;
  kilos: number;
  /** Suma de contado − esperado de los cierres (negativo = faltó). null si quien mira no ve los cierres. */
  cashDifference: number | null;
  /** Solo los faltantes (siempre ≤ 0). */
  cashShort: number;
  shortShifts: number;
  shifts: number;
  /** Cajero con más cierres con faltante, si hay. */
  shortCashier: { name: string; shifts: number } | null;
  voidedCount: number;
  voidedAmount: number;
  shiftOpen: boolean;
  lowStock: number;
}

export interface BranchRow extends BranchStats {
  rank: number;
  marginPct: number | null;
  change: number | null;
  avgTicket: number;
  /** Ancho de la barra, en % del local que más vendió. */
  barPct: number;
}

export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export function changePct(current: number, previous: number | null): number | null {
  if (previous === null || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function rankBranches(stats: BranchStats[]): BranchRow[] {
  const max = Math.max(1, ...stats.map((s) => s.sales));
  return [...stats]
    .sort((a, b) => b.sales - a.sales)
    .map((s, i) => ({
      ...s,
      rank: i + 1,
      marginPct: pct(s.grossProfit, s.sales),
      change: changePct(s.sales, s.prevSales),
      avgTicket: s.posSales > 0 ? Math.round(s.posTotal / s.posSales) : 0,
      barPct: Math.round((s.sales / max) * 100)
    }));
}

export interface BranchTotals {
  sales: number;
  prevSales: number | null;
  change: number | null;
  grossProfit: number;
  marginPct: number | null;
  result: number;
  posSales: number;
  avgTicket: number;
  kilos: number;
  cashDifference: number | null;
  cashShort: number;
  shortShifts: number;
  shifts: number;
  voidedCount: number;
}

export function branchTotals(stats: BranchStats[]): BranchTotals {
  const sum = (f: (s: BranchStats) => number) => stats.reduce((acc, s) => acc + f(s), 0);
  const sales = sum((s) => s.sales);
  const prevKnown = stats.every((s) => s.prevSales !== null);
  const prevSales = prevKnown ? sum((s) => s.prevSales ?? 0) : null;
  const posSales = sum((s) => s.posSales);
  const grossProfit = sum((s) => s.grossProfit);
  const seesCash = stats.some((s) => s.cashDifference !== null);
  return {
    sales,
    prevSales,
    change: changePct(sales, prevSales),
    grossProfit,
    marginPct: pct(grossProfit, sales),
    result: sum((s) => s.result),
    posSales,
    avgTicket: posSales > 0 ? Math.round(sum((s) => s.posTotal) / posSales) : 0,
    kilos: Math.round(sum((s) => s.kilos) * 10) / 10,
    cashDifference: seesCash ? sum((s) => s.cashDifference ?? 0) : null,
    cashShort: sum((s) => s.cashShort),
    shortShifts: sum((s) => s.shortShifts),
    shifts: sum((s) => s.shifts),
    voidedCount: sum((s) => s.voidedCount)
  };
}

export interface BranchAlert {
  branchId: string;
  tone: "danger" | "warn" | "info";
  title: string;
  detail: string;
}

/**
 * Lo que el dueño de una cadena tiene que mirar primero. Ordenado de más grave a menos.
 * includesToday: el período incluye hoy (solo entonces tiene sentido "no abrió la caja").
 * hour: hora actual en Argentina (no se avisa de una caja sin abrir antes de las 10 ni después de las 20).
 */
export function branchAlerts(rows: BranchRow[], opts: { includesToday: boolean; hour: number }): BranchAlert[] {
  const alerts: BranchAlert[] = [];
  const totalSales = rows.reduce((a, r) => a + r.sales, 0);
  const totalGross = rows.reduce((a, r) => a + r.grossProfit, 0);
  const avgMargin = pct(totalGross, totalSales);
  for (const r of rows) {
    if (r.cashShort <= -1) {
      const who = r.shortCashier && r.shortCashier.shifts === r.shortShifts && r.shortShifts > 1 ? `, todos de ${r.shortCashier.name}` : "";
      alerts.push({
        branchId: r.branchId,
        tone: "danger",
        title: `${r.branchName}: faltaron $ ${formatThousands(-r.cashShort)} en ${r.shortShifts} ${r.shortShifts === 1 ? "cierre" : "cierres"}`,
        detail: `de ${r.shifts} cierres de caja del período${who}`
      });
    }
    if (opts.includesToday && !r.shiftOpen && r.sales > 0 && opts.hour >= 10 && opts.hour < 20) {
      alerts.push({ branchId: r.branchId, tone: "warn", title: `${r.branchName} no tiene la caja abierta`, detail: "a esta hora suele estar vendiendo" });
    }
    if (r.change !== null && r.change <= -10) {
      alerts.push({ branchId: r.branchId, tone: "warn", title: `${r.branchName} vendió ${String(-r.change).replace(".", ",")}% menos`, detail: "que en el período anterior del mismo largo" });
    }
    if (avgMargin !== null && r.marginPct !== null && r.sales > 0 && r.marginPct < avgMargin - 5) {
      alerts.push({
        branchId: r.branchId,
        tone: "warn",
        title: `${r.branchName} deja menos margen: ${String(r.marginPct).replace(".", ",")}%`,
        detail: `los locales juntos dejan ${String(avgMargin).replace(".", ",")}%: ¿mermas, descuentos o precios viejos?`
      });
    }
    if (r.lowStock >= 5) {
      alerts.push({ branchId: r.branchId, tone: "info", title: `${r.branchName} tiene ${r.lowStock} productos debajo del mínimo`, detail: "conviene reponer" });
    }
  }
  const order = { danger: 0, warn: 1, info: 2 };
  return alerts.sort((a, b) => order[a.tone] - order[b.tone]);
}

function formatThousands(n: number): string {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(Math.round(n));
}

/** Ventas sumadas por día de la semana (1 = lunes) de todos los locales. */
export function salesByWeekday(hours: { dow: number; total: number }[][]): { dow: number; total: number }[] {
  const byDow = new Map<number, number>();
  for (const branch of hours) for (const h of branch) byDow.set(h.dow, (byDow.get(h.dow) ?? 0) + h.total);
  return [1, 2, 3, 4, 5, 6, 7].map((dow) => ({ dow, total: Math.round(byDow.get(dow) ?? 0) }));
}
