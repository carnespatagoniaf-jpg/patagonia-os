import { supabase } from "../../lib/supabase";
import { listPosCashiers } from "./pos-shift-service";

// Control de caja para el dueño (migración 117): caja fuerte (saldo,
// retiros con su número de papelito, conteos) e historial de cierres.

export interface SafeAccount {
  id: string;
  name: string;
  balance: number;
}

export interface SafeDeposit {
  id: string;
  number: number;
  amount: number;
  createdAt: string;
  posShiftId: string;
  employeeName: string | null;
  createdByName: string | null;
  voidedAt: string | null;
}

export interface SafeCount {
  id: string;
  counted: number;
  expected: number;
  difference: number;
  notes: string | null;
  createdAt: string;
}

export interface SafeWithdrawal {
  id: string;
  amount: number;
  notes: string | null;
  createdAt: string;
}

export interface ShiftCloseRow {
  id: string;
  openedAt: string;
  closedAt: string | null;
  status: "open" | "closed";
  cashierName: string | null;
  cashierWithPin: boolean;
  expectedCash: number | null;
  countedCash: number | null;
  difference: number | null;
  attempts: number;
  firstCashDifference: number | null;
  lastAccounts: { name: string; declared: number | null; expected: number; difference: number | null }[];
  safeTotal: number;
  safeCount: number;
  paymentChanges: number;
}

const toNum = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function listSafeAccounts(): Promise<SafeAccount[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("treasury_accounts").select("id,name").eq("is_safe", true).eq("active", true).order("name");
  if (error) {
    if (error.code === "42703") return []; // base sin la migración 117
    throw error;
  }
  const accounts = (data ?? []) as { id: string; name: string }[];
  if (accounts.length === 0) return [];
  const { data: balances, error: balanceError } = await supabase
    .from("treasury_balance")
    .select("account_id,balance")
    .in("account_id", accounts.map((a) => a.id));
  if (balanceError) throw balanceError;
  const byId = new Map(((balances ?? []) as { account_id: string; balance: number }[]).map((b) => [b.account_id, Number(b.balance)]));
  return accounts.map((a) => ({ id: a.id, name: a.name, balance: byId.get(a.id) ?? 0 }));
}

export async function listSafeCounts(safeAccountId: string, limit = 10): Promise<SafeCount[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("safe_counts")
    .select("id,counted,expected,difference,notes,created_at")
    .eq("safe_account_id", safeAccountId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    counted: Number(r.counted),
    expected: Number(r.expected),
    difference: Number(r.difference),
    notes: (r.notes as string | null) ?? null,
    createdAt: String(r.created_at)
  }));
}

/** Retiros que entraron a la caja fuerte desde `sinceIso` (el último conteo). */
export async function listSafeDeposits(safeAccountId: string, sinceIso: string | null): Promise<SafeDeposit[]> {
  if (!supabase) return [];
  let query = supabase
    .from("pos_safe_deposits")
    .select("id,number,amount,created_at,pos_shift_id,employee_id,created_by,voided_at")
    .eq("safe_account_id", safeAccountId)
    .order("number", { ascending: false })
    .limit(300);
  if (sinceIso) query = query.gt("created_at", sinceIso);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];

  const cashiers = await listPosCashiers(null).catch(() => []);
  const employeeName = new Map(cashiers.map((c) => [c.employeeId, c.fullName]));
  const userIds = [...new Set(rows.map((r) => r.created_by as string | null).filter((id): id is string => !!id))];
  const userName = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profiles } = await supabase.from("profiles").select("id,full_name").in("id", userIds);
    for (const p of (profiles ?? []) as { id: string; full_name: string }[]) userName.set(p.id, p.full_name);
  }

  return rows.map((r) => ({
    id: String(r.id),
    number: Number(r.number),
    amount: Number(r.amount),
    createdAt: String(r.created_at),
    posShiftId: String(r.pos_shift_id),
    employeeName: employeeName.get(String(r.employee_id ?? "")) ?? null,
    createdByName: userName.get(String(r.created_by ?? "")) ?? null,
    voidedAt: (r.voided_at as string | null) ?? null
  }));
}

/** Lo que salió de la caja fuerte (el dueño la vació, pagó algo) desde el último conteo. */
export async function listSafeWithdrawals(safeAccountId: string, sinceIso: string | null): Promise<SafeWithdrawal[]> {
  if (!supabase) return [];
  let query = supabase
    .from("treasury_movements")
    .select("id,amount,notes,created_at,reference_type")
    .eq("account_id", safeAccountId)
    .eq("direction", "out")
    .order("created_at", { ascending: false })
    .limit(200);
  if (sinceIso) query = query.gt("created_at", sinceIso);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[])
    .filter((r) => r.reference_type !== "safe_count")
    .map((r) => ({ id: String(r.id), amount: Number(r.amount), notes: (r.notes as string | null) ?? null, createdAt: String(r.created_at) }));
}

export async function countSafe(safeAccountId: string, counted: number, notes?: string): Promise<{ expected: number; difference: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("count_safe", { p_safe_account_id: safeAccountId, p_counted: counted, p_notes: notes ?? null });
  if (error) throw error;
  return { expected: Number(data.expected), difference: Number(data.difference) };
}

export async function listPosShiftCloses(branchId: string, days = 30): Promise<ShiftCloseRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("list_pos_shift_closes", { p_branch_id: branchId, p_days: days });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    openedAt: String(r.opened_at),
    closedAt: (r.closed_at as string | null) ?? null,
    status: r.status === "open" ? "open" : "closed",
    cashierName: (r.cashier_name as string | null) ?? null,
    cashierWithPin: r.cashier_with_pin === true,
    expectedCash: toNum(r.expected_cash),
    countedCash: toNum(r.counted_cash),
    difference: toNum(r.difference),
    attempts: Number(r.attempts ?? 0),
    firstCashDifference: toNum(r.first_cash_difference),
    lastAccounts: Array.isArray(r.last_accounts)
      ? (r.last_accounts as Record<string, unknown>[]).map((a) => ({
          name: String(a.name ?? ""),
          declared: toNum(a.declared),
          expected: Number(a.expected ?? 0),
          difference: toNum(a.difference)
        }))
      : [],
    safeTotal: Number(r.safe_total ?? 0),
    safeCount: Number(r.safe_count ?? 0),
    paymentChanges: Number(r.payment_changes ?? 0)
  }));
}

export async function setEmployeePosPin(employeeId: string, pin: string | null): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_employee_pos_pin", { p_employee_id: employeeId, p_pin: pin });
  if (error) throw error;
}

// Retiros de dinero (migración 164): la plata sigue en Efectivo; el dueño cuenta los papelitos.

export interface PendingWithdrawal {
  id: string;
  number: number;
  amount: number;
  createdAt: string;
  employeeName: string | null;
}

/** Retiros nuevos de la sucursal que el dueño todavía no contó. */
export async function listPendingWithdrawals(branchId: string): Promise<PendingWithdrawal[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("pos_safe_deposits")
    .select("id,number,amount,created_at,employees(full_name)")
    .eq("branch_id", branchId)
    .is("out_movement_id", null)
    .is("voided_at", null)
    .is("count_id", null)
    .order("number");
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{ id: string; number: number; amount: number; created_at: string; employees: { full_name: string } | null }>).map((r) => ({
    id: r.id,
    number: Number(r.number),
    amount: Number(r.amount),
    createdAt: r.created_at,
    employeeName: r.employees?.full_name ?? null
  }));
}

export interface WithdrawalCount {
  id: string;
  numbers: number[];
  expected: number;
  counted: number;
  difference: number;
  createdAt: string;
}

export async function listWithdrawalCounts(branchId: string, limit = 5): Promise<WithdrawalCount[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("pos_cash_withdrawal_counts")
    .select("id,numbers,expected,counted,difference,created_at")
    .eq("branch_id", branchId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return ((data ?? []) as Array<{ id: string; numbers: number[]; expected: number; counted: number; difference: number; created_at: string }>).map((r) => ({
    id: r.id,
    numbers: r.numbers.map(Number),
    expected: Number(r.expected),
    counted: Number(r.counted),
    difference: Number(r.difference),
    createdAt: r.created_at
  }));
}

export async function countCashWithdrawals(branchId: string, counted: number, notes?: string): Promise<{ numbers: number[]; expected: number; difference: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("count_cash_withdrawals", { p_branch_id: branchId, p_counted: counted, p_notes: notes ?? null });
  if (error) throw error;
  return { numbers: (data.numbers ?? []).map(Number), expected: Number(data.expected), difference: Number(data.difference) };
}

/** "Controlar la balanza al cerrar" (companies.features 'control_balanza'). */
export async function setScaleCloseControl(enabled: boolean): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_scale_close_control", { p_enabled: enabled });
  if (error) throw error;
}
