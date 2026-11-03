/**
 * Rentabilidad (rediseño 2026-11-02): "¿Cuánto gané?" de punta a punta, con la misma cuenta que
 * Reportes → Resultado (period-result.ts) más los costos fijos que se cargan acá.
 * Antes la ganancia de esta pantalla no restaba los gastos ni los sueldos cargados en el sistema
 * y daba distinta que la de Reportes.
 */
export interface ProfitInputs {
  sales: number;
  grossProfit: number;
  /** Faltantes de stock + decomisos. */
  losses: number;
  expenses: number;
  salaries: number;
  /** Costos fijos de este período (prorrateados por día). */
  fixedPeriod: number;
  /** Costos fijos por mes, sin prorratear. */
  fixedMonthly: number;
  days: number;
}

export interface ProfitView {
  net: number;
  netPct: number | null;
  grossPct: number | null;
  /** Lo que hay que vender por mes para no perder plata (null si no hay margen o no hay ventas). */
  breakEvenMonthly: number | null;
  breakEvenDaily: number | null;
}

export function profitView(p: ProfitInputs): ProfitView {
  const net = p.grossProfit - p.losses - p.expenses - p.salaries - p.fixedPeriod;
  const pct = (n: number) => (p.sales > 0 ? Math.round((n / p.sales) * 1000) / 10 : null);
  const marginRatio = p.sales > 0 ? p.grossProfit / p.sales : 0;
  const days = Math.max(1, p.days);
  // Lo que se va por mes sin importar cuánto vendas: costos fijos + gastos, sueldos y mermas llevados a 30 días.
  const monthlyNeeds = p.fixedMonthly + ((p.expenses + p.salaries + p.losses) / days) * 30;
  const breakEvenMonthly = marginRatio > 0 && monthlyNeeds > 0 ? Math.round(monthlyNeeds / marginRatio) : null;
  return {
    net: Math.round(net * 100) / 100,
    netPct: pct(net),
    grossPct: pct(p.grossProfit),
    breakEvenMonthly,
    breakEvenDaily: breakEvenMonthly === null ? null : Math.round(breakEvenMonthly / 30)
  };
}

/** Variación contra el período anterior, en %; null si no hay con qué comparar. */
export function changePct(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}
