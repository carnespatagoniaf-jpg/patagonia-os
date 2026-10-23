// Reportes → "Resultado del período" y "Merma" (2026-10-22). Datos de
// period_result_report (migración 145). Pura, para probarla con node --test.

export interface PeriodResultData {
  sales: {
    mostradorTotal: number;
    mostradorSales: number;
    /** Renglones de Mostrador con producto: importe y costo (costo 0 si el producto no tiene costo). */
    identifiedAmount: number;
    identifiedCost: number;
    /** Parte de identifiedAmount vendida sin costo cargado. */
    missingCostAmount: number;
    /** Renglones sin producto (ticket de total de la balanza, "vender algo sin código"). */
    unidentifiedAmount: number;
    accountTotal: number;
    accountItemsCost: number;
    /** Cargos a cuenta sin artículos: no se sabe qué costaron. */
    accountWithoutItems: number;
    turnosTotal: number;
  };
  expenses: Array<{ kind: "gasto" | "sueldos"; category: string; amount: number; count: number }>;
  stockAdjustments: Array<{
    productId: string;
    productName: string;
    productCode: string | null;
    unit: string | null;
    lostQty: number;
    lostValue: number;
    foundQty: number;
    foundValue: number;
    count: number;
    reasons: string[];
  }>;
  /** Decomisos (migración 151): lo que se tiró, por producto y motivo, al costo de ese momento. */
  wastes: Array<{
    productId: string;
    productName: string;
    productCode: string | null;
    unit: string | null;
    reason: string;
    quantity: number;
    value: number;
    count: number;
  }>;
  carcass: Array<{
    id: string;
    date: string;
    animalType: string;
    supplier: string | null;
    totalWeight: number;
    totalCost: number;
    cutsWeight: number;
    cuts: number;
  }>;
}

const num = (v: unknown) => Number(v ?? 0) || 0;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function parsePeriodResult(data: unknown): PeriodResultData {
  const raw = (data ?? {}) as Record<string, any>;
  const s = raw.sales ?? {};
  const lines = s.lines ?? {};
  return {
    sales: {
      mostradorTotal: num(s.mostrador_total),
      mostradorSales: num(s.mostrador_sales),
      identifiedAmount: num(lines.identified_amount),
      identifiedCost: num(lines.identified_cost),
      missingCostAmount: num(lines.missing_cost_amount),
      unidentifiedAmount: num(lines.unidentified_amount),
      accountTotal: num(s.account_total),
      accountItemsCost: num(s.account_items_cost),
      accountWithoutItems: num(s.account_without_items),
      turnosTotal: num(s.turnos_total)
    },
    expenses: ((raw.expenses ?? []) as Array<Record<string, unknown>>).map((e) => ({
      kind: e.kind === "gasto" ? "gasto" : "sueldos",
      category: String(e.category ?? "otro"),
      amount: num(e.amount),
      count: num(e.count)
    })),
    stockAdjustments: ((raw.stock_adjustments ?? []) as Array<Record<string, unknown>>).map((a) => ({
      productId: String(a.product_id),
      productName: String(a.product_name ?? ""),
      productCode: (a.product_code as string | null) ?? null,
      unit: (a.unit as string | null) ?? null,
      lostQty: num(a.lost_qty),
      lostValue: num(a.lost_value),
      foundQty: num(a.found_qty),
      foundValue: num(a.found_value),
      count: num(a.count),
      reasons: Array.isArray(a.reasons) ? (a.reasons as unknown[]).map(String) : []
    })),
    wastes: ((raw.wastes ?? []) as Array<Record<string, unknown>>).map((w) => ({
      productId: String(w.product_id),
      productName: String(w.product_name ?? ""),
      productCode: (w.product_code as string | null) ?? null,
      unit: (w.unit as string | null) ?? null,
      reason: String(w.reason ?? "otro"),
      quantity: num(w.quantity),
      value: num(w.value),
      count: num(w.count)
    })),
    carcass: ((raw.carcass ?? []) as Array<Record<string, unknown>>).map((c) => ({
      id: String(c.id),
      date: String(c.date ?? ""),
      animalType: String(c.animal_type ?? ""),
      supplier: (c.supplier as string | null) ?? null,
      totalWeight: num(c.total_weight),
      totalCost: num(c.total_cost),
      cutsWeight: num(c.cuts_weight),
      cuts: num(c.cuts)
    }))
  };
}

export const EXPENSE_LABELS: Record<string, string> = {
  mantenimiento: "Mantenimiento / reparaciones",
  servicios: "Servicios (luz, gas, alquiler)",
  impuestos: "Impuestos",
  insumos: "Insumos varios",
  otro: "Otros gastos",
  sueldo: "Liquidaciones de sueldo",
  vale_adelanto: "Vales · adelanto de sueldo",
  vale_mercaderia: "Vales · mercadería"
};

export interface PeriodResult {
  sales: number;
  salesMostrador: number;
  salesAccount: number;
  salesTurnos: number;
  /** Costo de lo vendido (real + estimado). */
  cost: number;
  /** Parte del costo que es estimada (ventas sin costo cargado o sin producto). */
  estimatedCost: number;
  /** Ventas cuyo costo se estimó. */
  estimatedSales: number;
  /** Costo / importe de lo que sí tiene costo; null si nada tiene costo (no se puede estimar). */
  costRatio: number | null;
  grossProfit: number;
  stockLoss: number;
  /** Decomisos: lo que se tiró (vencido, en mal estado, roto), a costo. */
  wasteLoss: number;
  /** Sobrantes de los conteos: se muestran, pero no se suman (pueden ser correcciones de carga). */
  stockFound: number;
  expenses: number;
  salaries: number;
  expenseLines: Array<{ category: string; label: string; amount: number }>;
  salaryLines: Array<{ category: string; label: string; amount: number }>;
  result: number;
  /** Resultado sobre ventas, en %. null sin ventas. */
  resultPct: number | null;
  grossPct: number | null;
}

export const WASTE_REASON_LABELS: Record<string, string> = {
  vencido: "Vencido",
  mal_estado: "En mal estado",
  roto: "Se cayó o se rompió",
  otro: "Otro"
};

/**
 * Ventas − costo de lo vendido − faltantes de stock − decomisos − gastos − sueldos.
 * Lo vendido sin costo cargado, sin producto, a cuenta sin artículos y por Turnos
 * se costea con el mismo margen que el resto de lo vendido (estimado).
 */
export function computePeriodResult(d: PeriodResultData): PeriodResult {
  const s = d.sales;
  const costedAmount = s.identifiedAmount - s.missingCostAmount;
  const costRatio = costedAmount > 0 && s.identifiedCost > 0 ? s.identifiedCost / costedAmount : null;
  const estimatedSales = s.missingCostAmount + s.unidentifiedAmount + s.accountWithoutItems + s.turnosTotal;
  const estimatedCost = costRatio === null ? 0 : estimatedSales * costRatio;
  const cost = s.identifiedCost + s.accountItemsCost + estimatedCost;
  const sales = s.mostradorTotal + s.accountTotal + s.turnosTotal;
  const grossProfit = sales - cost;
  const stockLoss = d.stockAdjustments.reduce((sum, a) => sum + a.lostValue, 0);
  const stockFound = d.stockAdjustments.reduce((sum, a) => sum + a.foundValue, 0);
  const wasteLoss = d.wastes.reduce((sum, w) => sum + w.value, 0);
  const lines = (kind: "gasto" | "sueldos") =>
    d.expenses
      .filter((e) => e.kind === kind)
      .map((e) => ({ category: e.category, label: EXPENSE_LABELS[e.category] ?? e.category, amount: round2(e.amount) }))
      .sort((a, b) => b.amount - a.amount);
  const expenseLines = lines("gasto");
  const salaryLines = lines("sueldos");
  const expenses = expenseLines.reduce((sum, e) => sum + e.amount, 0);
  const salaries = salaryLines.reduce((sum, e) => sum + e.amount, 0);
  const result = grossProfit - stockLoss - wasteLoss - expenses - salaries;
  const pct = (n: number) => (sales > 0 ? Math.round((n / sales) * 1000) / 10 : null);
  return {
    sales: round2(sales),
    salesMostrador: round2(s.mostradorTotal),
    salesAccount: round2(s.accountTotal),
    salesTurnos: round2(s.turnosTotal),
    cost: round2(cost),
    estimatedCost: round2(estimatedCost),
    estimatedSales: round2(estimatedSales),
    costRatio,
    grossProfit: round2(grossProfit),
    stockLoss: round2(stockLoss),
    wasteLoss: round2(wasteLoss),
    stockFound: round2(stockFound),
    expenses: round2(expenses),
    salaries: round2(salaries),
    expenseLines,
    salaryLines,
    result: round2(result),
    resultPct: pct(result),
    grossPct: pct(grossProfit)
  };
}

export interface CarcassLoss {
  id: string;
  date: string;
  animalType: string;
  supplier: string | null;
  totalWeight: number;
  cutsWeight: number;
  lossKg: number;
  /** % de merma sobre lo comprado. null si todavía no tiene cortes cargados. */
  lossPct: number | null;
  /** Lo que costaron los kilos que no salieron como cortes (hueso, grasa, oreo). */
  lossValue: number;
  /** Merma muy alta: probablemente faltan cargar cortes. */
  suspicious: boolean;
  noCuts: boolean;
}

/** Más de esto de merma en un desposte suele ser cortes sin cargar, no merma real. */
export const SUSPICIOUS_CARCASS_LOSS_PCT = 35;

export function carcassLosses(rows: PeriodResultData["carcass"]): { batches: CarcassLoss[]; totalWeight: number; cutsWeight: number; lossKg: number; lossPct: number | null; lossValue: number } {
  const batches = rows.map((b) => {
    const noCuts = b.cuts === 0;
    const lossKg = noCuts ? 0 : Math.max(b.totalWeight - b.cutsWeight, 0);
    const lossPct = noCuts || b.totalWeight <= 0 ? null : Math.round((lossKg / b.totalWeight) * 1000) / 10;
    const costPerKg = b.totalWeight > 0 ? b.totalCost / b.totalWeight : 0;
    return {
      id: b.id,
      date: b.date,
      animalType: b.animalType,
      supplier: b.supplier,
      totalWeight: b.totalWeight,
      cutsWeight: b.cutsWeight,
      lossKg: Math.round(lossKg * 1000) / 1000,
      lossPct,
      lossValue: round2(lossKg * costPerKg),
      suspicious: lossPct !== null && lossPct > SUSPICIOUS_CARCASS_LOSS_PCT,
      noCuts
    };
  });
  // Los totales solo cuentan despostes ya cargados y creíbles.
  const counted = batches.filter((b) => !b.noCuts && !b.suspicious);
  const totalWeight = counted.reduce((sum, b) => sum + b.totalWeight, 0);
  const cutsWeight = counted.reduce((sum, b) => sum + b.cutsWeight, 0);
  const lossKg = counted.reduce((sum, b) => sum + b.lossKg, 0);
  return {
    batches,
    totalWeight: Math.round(totalWeight * 1000) / 1000,
    cutsWeight: Math.round(cutsWeight * 1000) / 1000,
    lossKg: Math.round(lossKg * 1000) / 1000,
    lossPct: totalWeight > 0 ? Math.round((lossKg / totalWeight) * 1000) / 10 : null,
    lossValue: round2(counted.reduce((sum, b) => sum + b.lossValue, 0))
  };
}
