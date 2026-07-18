import type { ShiftOutflow, ShiftOutflowType, ShiftPeriod, ShiftRegister, ShiftSale } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

interface ShiftRegisterRow {
  id: string;
  branch_id: string;
  shift_date: string;
  shift: ShiftPeriod;
  opening_cash: number;
  closing_counted_cash: number | null;
  created_at: string;
  updated_at: string;
}

function mapShift(row: ShiftRegisterRow): ShiftRegister {
  return {
    id: row.id,
    branchId: row.branch_id,
    shiftDate: row.shift_date,
    shift: row.shift,
    openingCash: Number(row.opening_cash),
    closingCountedCash: row.closing_counted_cash !== null ? Number(row.closing_counted_cash) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function fetchShift(branchId: string, shiftDate: string, shift: ShiftPeriod): Promise<ShiftRegister | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("shift_registers")
    .select("id,branch_id,shift_date,shift,opening_cash,closing_counted_cash,created_at,updated_at")
    .eq("branch_id", branchId)
    .eq("shift_date", shiftDate)
    .eq("shift", shift)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return mapShift(data as ShiftRegisterRow);
}

export interface SaveShiftInput {
  branchId: string;
  shiftDate: string;
  shift: ShiftPeriod;
  openingCash: number;
  closingCountedCash?: number;
}

export async function saveShift(input: SaveShiftInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("save_shift", {
    p_branch_id: input.branchId,
    p_shift_date: input.shiftDate,
    p_shift: input.shift,
    p_opening_cash: input.openingCash,
    p_closing_counted_cash: input.closingCountedCash ?? null
  });

  if (error) throw error;
  return { id: data.id };
}

interface ShiftSaleRow {
  id: string;
  shift_id: string;
  account_id: string;
  amount: number;
}

function mapSale(row: ShiftSaleRow): ShiftSale {
  return { id: row.id, shiftId: row.shift_id, accountId: row.account_id, amount: Number(row.amount) };
}

export async function listShiftSales(shiftId: string): Promise<ShiftSale[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("shift_sales")
    .select("id,shift_id,account_id,amount")
    .eq("shift_id", shiftId);

  if (error) throw error;
  return (data ?? []).map(mapSale);
}

export interface SaveShiftSaleInput {
  id?: string;
  shiftId: string;
  accountId: string;
  amount: number;
}

export async function saveShiftSale(input: SaveShiftSaleInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("save_shift_sale", {
    p_sale_id: input.id ?? null,
    p_shift_id: input.shiftId,
    p_account_id: input.accountId,
    p_amount: input.amount
  });

  if (error) throw error;
  return { id: data.id };
}

export async function deleteShiftSale(saleId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_shift_sale", { p_sale_id: saleId });
  if (error) throw error;
}

interface ShiftOutflowRow {
  id: string;
  shift_id: string;
  account_id: string;
  type: ShiftOutflowType;
  amount: number;
  detail: string;
  employee_id: string | null;
  supplier_id: string | null;
  created_at: string;
}

function mapOutflow(row: ShiftOutflowRow): ShiftOutflow {
  return {
    id: row.id,
    shiftId: row.shift_id,
    accountId: row.account_id,
    type: row.type,
    amount: Number(row.amount),
    detail: row.detail,
    employeeId: row.employee_id ?? undefined,
    supplierId: row.supplier_id ?? undefined,
    createdAt: row.created_at
  };
}

export async function listShiftOutflows(shiftId: string): Promise<ShiftOutflow[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("shift_outflows")
    .select("id,shift_id,account_id,type,amount,detail,employee_id,supplier_id,created_at")
    .eq("shift_id", shiftId)
    .order("created_at");

  if (error) throw error;
  return (data ?? []).map(mapOutflow);
}

export interface SaveShiftOutflowInput {
  id?: string;
  shiftId: string;
  accountId: string;
  type: ShiftOutflowType;
  amount: number;
  detail: string;
  employeeId?: string;
  supplierId?: string;
}

export async function saveShiftOutflow(input: SaveShiftOutflowInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("save_shift_outflow", {
    p_shift_outflow_id: input.id ?? null,
    p_shift_id: input.shiftId,
    p_account_id: input.accountId,
    p_type: input.type,
    p_amount: input.amount,
    p_detail: input.detail,
    p_employee_id: input.employeeId ?? null,
    p_supplier_id: input.supplierId ?? null
  });

  if (error) throw error;
  return { id: data.id };
}

export async function deleteShiftOutflow(outflowId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_shift_outflow", { p_shift_outflow_id: outflowId });
  if (error) throw error;
}

export interface ShiftRangeRow {
  shift: ShiftRegister;
  sales: ShiftSale[];
  outflows: ShiftOutflow[];
}

export async function listShiftsInRange(branchId: string, fromDate: string, toDate: string): Promise<ShiftRangeRow[]> {
  if (!supabase) return [];

  const { data: shiftRows, error: shiftError } = await supabase
    .from("shift_registers")
    .select("id,branch_id,shift_date,shift,opening_cash,closing_counted_cash,created_at,updated_at")
    .eq("branch_id", branchId)
    .gte("shift_date", fromDate)
    .lte("shift_date", toDate)
    .order("shift_date");

  if (shiftError) throw shiftError;
  const shifts = (shiftRows ?? []).map((row) => mapShift(row as ShiftRegisterRow));
  if (shifts.length === 0) return [];

  const shiftIds = shifts.map((s) => s.id);

  const [{ data: saleRows, error: saleError }, { data: outflowRows, error: outflowError }] = await Promise.all([
    supabase.from("shift_sales").select("id,shift_id,account_id,amount").in("shift_id", shiftIds),
    supabase
      .from("shift_outflows")
      .select("id,shift_id,account_id,type,amount,detail,employee_id,supplier_id,created_at")
      .in("shift_id", shiftIds)
  ]);

  if (saleError) throw saleError;
  if (outflowError) throw outflowError;

  const sales = (saleRows ?? []).map((row) => mapSale(row as ShiftSaleRow));
  const outflows = (outflowRows ?? []).map((row) => mapOutflow(row as ShiftOutflowRow));

  return shifts.map((shift) => ({
    shift,
    sales: sales.filter((s) => s.shiftId === shift.id),
    outflows: outflows.filter((o) => o.shiftId === shift.id)
  }));
}
