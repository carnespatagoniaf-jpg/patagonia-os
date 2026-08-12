import type { Employee, PayrollAdjustment, PayrollAdjustmentType, PayrollLiquidation, SalaryPeriod, ShiftOutflow } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

interface EmployeeRow {
  id: string;
  branch_id: string;
  full_name: string;
  base_salary: number;
  salary_period: SalaryPeriod;
  recurring_bonus_amount: number;
  recurring_bonus_reason: string | null;
  active: boolean;
}

function mapEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    branchId: row.branch_id,
    fullName: row.full_name,
    baseSalary: Number(row.base_salary),
    salaryPeriod: row.salary_period,
    recurringBonusAmount: Number(row.recurring_bonus_amount ?? 0),
    recurringBonusReason: row.recurring_bonus_reason ?? undefined,
    active: row.active
  };
}

export async function listEmployees(includeInactive = false): Promise<Employee[]> {
  if (!supabase) return [];

  let query = supabase
    .from("employees")
    .select("id,branch_id,full_name,base_salary,salary_period,recurring_bonus_amount,recurring_bonus_reason,active")
    .order("full_name");
  if (!includeInactive) query = query.eq("active", true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapEmployee);
}

export interface CreateEmployeeInput {
  branchId: string;
  fullName: string;
  baseSalary: number;
  salaryPeriod: SalaryPeriod;
  recurringBonusAmount: number;
  recurringBonusReason?: string;
}

export async function createEmployee(input: CreateEmployeeInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_employee", {
    p_branch_id: input.branchId,
    p_full_name: input.fullName,
    p_base_salary: input.baseSalary,
    p_salary_period: input.salaryPeriod,
    p_recurring_bonus_amount: input.recurringBonusAmount,
    p_recurring_bonus_reason: input.recurringBonusReason ?? null
  });

  if (error) throw error;
  return { id: data.id };
}

export interface UpdateEmployeeInput {
  id: string;
  fullName: string;
  baseSalary: number;
  salaryPeriod: SalaryPeriod;
  recurringBonusAmount: number;
  recurringBonusReason?: string;
  active: boolean;
}

export async function updateEmployee(input: UpdateEmployeeInput): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("update_employee", {
    p_employee_id: input.id,
    p_full_name: input.fullName,
    p_base_salary: input.baseSalary,
    p_recurring_bonus_amount: input.recurringBonusAmount,
    p_recurring_bonus_reason: input.recurringBonusReason ?? null,
    p_active: input.active,
    p_salary_period: input.salaryPeriod
  });

  if (error) throw error;
}

interface PayrollAdjustmentRow {
  id: string;
  employee_id: string;
  adjustment_date: string;
  type: PayrollAdjustmentType;
  amount: number;
  reason: string;
}

function mapAdjustment(row: PayrollAdjustmentRow): PayrollAdjustment {
  return {
    id: row.id,
    employeeId: row.employee_id,
    adjustmentDate: row.adjustment_date,
    type: row.type,
    amount: Number(row.amount),
    reason: row.reason
  };
}

export async function listPayrollAdjustments(employeeId: string): Promise<PayrollAdjustment[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("payroll_adjustments")
    .select("id,employee_id,adjustment_date,type,amount,reason")
    .eq("employee_id", employeeId)
    .order("adjustment_date", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapAdjustment);
}

export interface CreatePayrollAdjustmentInput {
  employeeId: string;
  adjustmentDate: string;
  type: PayrollAdjustmentType;
  amount: number;
  reason: string;
}

export async function createPayrollAdjustment(input: CreatePayrollAdjustmentInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_payroll_adjustment", {
    p_employee_id: input.employeeId,
    p_adjustment_date: input.adjustmentDate,
    p_type: input.type,
    p_amount: input.amount,
    p_reason: input.reason
  });

  if (error) throw error;
  return { id: data.id };
}

export async function deletePayrollAdjustment(adjustmentId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_payroll_adjustment", { p_adjustment_id: adjustmentId });
  if (error) throw error;
}

interface VoucherQueryRow {
  id: string;
  shift_id: string;
  account_id: string;
  type: ShiftOutflow["type"];
  amount: number;
  detail: string;
  employee_id: string | null;
  supplier_id: string | null;
  payroll_liquidation_id: string | null;
  created_at: string;
  shift_registers: { shift_date: string; shift: "morning" | "afternoon" } | null;
}

export interface EmployeeVoucher {
  id: string;
  amount: number;
  type: ShiftOutflow["type"];
  detail: string;
  shiftDate: string;
  shift: "morning" | "afternoon";
  liquidated: boolean;
}

export async function listEmployeeVouchers(employeeId: string): Promise<EmployeeVoucher[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("shift_outflows")
    .select("id,shift_id,account_id,type,amount,detail,employee_id,supplier_id,payroll_liquidation_id,created_at,shift_registers(shift_date,shift)")
    .eq("employee_id", employeeId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as unknown as VoucherQueryRow[]).map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    type: row.type,
    detail: row.detail,
    shiftDate: row.shift_registers?.shift_date ?? "-",
    shift: row.shift_registers?.shift ?? "morning",
    liquidated: row.payroll_liquidation_id !== null
  }));
}

interface PayrollLiquidationRow {
  id: string;
  employee_id: string;
  branch_id: string;
  period_start: string;
  period_end: string;
  base_salary: number;
  adjustments_total: number;
  vouchers_total: number;
  net_amount: number;
  account_id: string | null;
  treasury_accounts: { name: string } | { name: string }[] | null;
  created_at: string;
}

function mapLiquidation(row: PayrollLiquidationRow): PayrollLiquidation {
  const account = Array.isArray(row.treasury_accounts) ? row.treasury_accounts[0] : row.treasury_accounts;
  return {
    id: row.id,
    employeeId: row.employee_id,
    branchId: row.branch_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    baseSalary: Number(row.base_salary),
    adjustmentsTotal: Number(row.adjustments_total),
    vouchersTotal: Number(row.vouchers_total),
    netAmount: Number(row.net_amount),
    accountId: row.account_id ?? undefined,
    accountName: account?.name,
    createdAt: row.created_at
  };
}

export async function listPayrollLiquidations(employeeId: string): Promise<PayrollLiquidation[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("payroll_liquidations")
    .select("id,employee_id,branch_id,period_start,period_end,base_salary,adjustments_total,vouchers_total,net_amount,account_id,treasury_accounts(name),created_at")
    .eq("employee_id", employeeId)
    .order("period_start", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as unknown as PayrollLiquidationRow[]).map(mapLiquidation);
}

export interface ClosePayrollLiquidationInput {
  branchId: string;
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  accountId?: string;
}

export async function closePayrollLiquidation(input: ClosePayrollLiquidationInput): Promise<PayrollLiquidation> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("close_payroll_liquidation", {
    p_branch_id: input.branchId,
    p_employee_id: input.employeeId,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_account_id: input.accountId ?? null
  });

  if (error) throw error;
  return {
    id: data.id,
    employeeId: input.employeeId,
    branchId: input.branchId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    baseSalary: Number(data.base_salary),
    adjustmentsTotal: Number(data.adjustments_total),
    vouchersTotal: Number(data.vouchers_total),
    netAmount: Number(data.net_amount),
    accountId: input.accountId,
    createdAt: new Date().toISOString()
  };
}

export async function deletePayrollLiquidation(liquidationId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_payroll_liquidation", { p_liquidation_id: liquidationId });
  if (error) throw error;
}
