import type { FixedCost, ProfitabilityPeriod, StockCount } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

interface FixedCostRow {
  id: string;
  branch_id: string;
  name: string;
  monthly_amount: number;
  active: boolean;
}

function mapFixedCost(row: FixedCostRow): FixedCost {
  return { id: row.id, branchId: row.branch_id, name: row.name, monthlyAmount: Number(row.monthly_amount), active: row.active };
}

export async function listFixedCosts(includeInactive = false): Promise<FixedCost[]> {
  if (!supabase) return [];

  let query = supabase.from("fixed_costs").select("id,branch_id,name,monthly_amount,active").order("name");
  if (!includeInactive) query = query.eq("active", true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapFixedCost);
}

export interface CreateFixedCostInput {
  branchId: string;
  name: string;
  monthlyAmount: number;
}

export async function createFixedCost(input: CreateFixedCostInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_fixed_cost", {
    p_branch_id: input.branchId,
    p_name: input.name,
    p_monthly_amount: input.monthlyAmount
  });

  if (error) throw error;
  return { id: data.id };
}

export interface UpdateFixedCostInput {
  id: string;
  name: string;
  monthlyAmount: number;
  active: boolean;
}

export async function updateFixedCost(input: UpdateFixedCostInput): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("update_fixed_cost", {
    p_fixed_cost_id: input.id,
    p_name: input.name,
    p_monthly_amount: input.monthlyAmount,
    p_active: input.active
  });

  if (error) throw error;
}

export async function getPurchasesTotalInRange(branchId: string, fromDate: string, toDate: string): Promise<number> {
  if (!supabase) return 0;

  const { data, error } = await supabase
    .from("purchases")
    .select("total")
    .eq("branch_id", branchId)
    .eq("status", "active")
    .gte("purchase_date", fromDate)
    .lte("purchase_date", toDate);

  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + Number(row.total), 0);
}

export interface PurchasedProductRanking {
  label: string;
  unit: "kg" | "unit";
  quantity: number;
  amount: number;
}

interface PurchaseItemRangeRow {
  quantity: number;
  unit: "kg" | "unit";
  line_total: number;
  description: string | null;
  products: { name: string } | null;
  purchases: { branch_id: string; purchase_date: string; status: string } | null;
}

export async function listPurchasedProductsInRange(branchId: string, fromDate: string, toDate: string): Promise<PurchasedProductRanking[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("purchase_items")
    .select("quantity,unit,line_total,description,products(name),purchases!inner(branch_id,purchase_date,status)")
    .eq("purchases.branch_id", branchId)
    .eq("purchases.status", "active")
    .gte("purchases.purchase_date", fromDate)
    .lte("purchases.purchase_date", toDate);

  if (error) throw error;

  const byLabel = new Map<string, PurchasedProductRanking>();
  for (const row of (data ?? []) as unknown as PurchaseItemRangeRow[]) {
    const label = row.products?.name ?? row.description ?? "-";
    const current = byLabel.get(label) ?? { label, unit: row.unit, quantity: 0, amount: 0 };
    current.quantity += Number(row.quantity);
    current.amount += Number(row.line_total);
    byLabel.set(label, current);
  }
  return Array.from(byLabel.values()).sort((a, b) => b.amount - a.amount);
}

interface ProfitabilityPeriodRow {
  id: string;
  branch_id: string;
  period_start: string;
  period_end: string;
  sales_total: number;
  purchases_total: number;
  fixed_costs_total: number;
  stock_start: number;
  stock_end: number;
  gross_profit: number;
  created_at: string;
}

function mapProfitabilityPeriod(row: ProfitabilityPeriodRow): ProfitabilityPeriod {
  return {
    id: row.id,
    branchId: row.branch_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    salesTotal: Number(row.sales_total),
    purchasesTotal: Number(row.purchases_total),
    fixedCostsTotal: Number(row.fixed_costs_total),
    stockStart: Number(row.stock_start),
    stockEnd: Number(row.stock_end),
    grossProfit: Number(row.gross_profit),
    createdAt: row.created_at
  };
}

export async function listProfitabilityPeriods(branchId: string): Promise<ProfitabilityPeriod[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("profitability_periods")
    .select("id,branch_id,period_start,period_end,sales_total,purchases_total,fixed_costs_total,stock_start,stock_end,gross_profit,created_at")
    .eq("branch_id", branchId)
    .order("period_start", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapProfitabilityPeriod);
}

interface StockCountRow {
  id: string;
  branch_id: string;
  count_date: string;
  category: string;
  value: number;
}

function mapStockCount(row: StockCountRow): StockCount {
  return { id: row.id, branchId: row.branch_id, countDate: row.count_date, category: row.category, value: Number(row.value) };
}

export async function listStockCounts(branchId: string, fromDate: string, toDate: string): Promise<StockCount[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("stock_counts")
    .select("id,branch_id,count_date,category,value")
    .eq("branch_id", branchId)
    .gte("count_date", fromDate)
    .lte("count_date", toDate)
    .order("count_date", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapStockCount);
}

export interface SaveStockCountInput {
  branchId: string;
  countDate: string;
  category: string;
  value: number;
}

export async function saveStockCount(input: SaveStockCountInput): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("save_stock_count", {
    p_branch_id: input.branchId,
    p_count_date: input.countDate,
    p_category: input.category,
    p_value: input.value
  });

  if (error) throw error;
}

export async function deleteStockCount(stockCountId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_stock_count", { p_stock_count_id: stockCountId });
  if (error) throw error;
}

export async function getStockTotalNearDate(branchId: string, date: string): Promise<{ date: string; total: number } | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("stock_counts")
    .select("count_date,value")
    .eq("branch_id", branchId)
    .lte("count_date", date)
    .order("count_date", { ascending: false });

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const latestDate = data[0].count_date;
  const total = data.filter((row) => row.count_date === latestDate).reduce((sum, row) => sum + Number(row.value), 0);
  return { date: latestDate, total };
}

export interface ClosePeriodInput {
  branchId: string;
  periodStart: string;
  periodEnd: string;
  stockStart: number;
  stockEnd: number;
}

export async function closeProfitabilityPeriod(input: ClosePeriodInput): Promise<ProfitabilityPeriod> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("close_profitability_period", {
    p_branch_id: input.branchId,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_stock_start: input.stockStart,
    p_stock_end: input.stockEnd
  });

  if (error) throw error;
  return {
    id: data.id,
    branchId: input.branchId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    salesTotal: Number(data.sales_total),
    purchasesTotal: Number(data.purchases_total),
    fixedCostsTotal: Number(data.fixed_costs_total),
    stockStart: Number(data.stock_start),
    stockEnd: Number(data.stock_end),
    grossProfit: Number(data.gross_profit),
    createdAt: new Date().toISOString()
  };
}
