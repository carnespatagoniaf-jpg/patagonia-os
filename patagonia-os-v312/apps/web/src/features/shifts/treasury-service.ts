import type { PaymentMethod, TreasuryAccount } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

interface TreasuryAccountRow {
  id: string;
  name: string;
  payment_method: PaymentMethod | null;
  initial_balance: number;
  active: boolean;
}

function mapAccount(row: TreasuryAccountRow): TreasuryAccount {
  return {
    id: row.id,
    name: row.name,
    paymentMethod: row.payment_method ?? undefined,
    initialBalance: Number(row.initial_balance),
    active: row.active
  };
}

export async function listTreasuryAccounts(): Promise<TreasuryAccount[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("treasury_accounts")
    .select("id,name,payment_method,initial_balance,active")
    .eq("active", true)
    .order("name");

  if (error) throw error;
  return (data ?? []).map(mapAccount);
}

/** Incluye cuentas inactivas — se usa solo para el listado de Saldos en Tesorería (activar/desactivar), no para los selectores de cobro/ajuste/transferencia. */
export async function listAllTreasuryAccounts(): Promise<TreasuryAccount[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("treasury_accounts")
    .select("id,name,payment_method,initial_balance,active")
    .order("name");

  if (error) throw error;
  return (data ?? []).map(mapAccount);
}

export interface CreateTreasuryAccountInput {
  name: string;
  paymentMethod?: PaymentMethod;
  initialBalance: number;
}

export async function createTreasuryAccount(input: CreateTreasuryAccountInput): Promise<TreasuryAccount> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_treasury_account", {
    p_name: input.name,
    p_payment_method: input.paymentMethod ?? null,
    p_initial_balance: input.initialBalance
  });

  if (error) throw error;
  return {
    id: data.id,
    name: data.name,
    paymentMethod: input.paymentMethod,
    initialBalance: input.initialBalance,
    active: true
  };
}

export interface TreasuryAccountBalance {
  accountId: string;
  name: string;
  initialBalance: number;
  balance: number;
}

export async function listTreasuryBalances(): Promise<TreasuryAccountBalance[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("treasury_balance")
    .select("account_id,name,initial_balance,balance")
    .order("name");

  if (error) throw error;
  return (data ?? []).map((row) => ({
    accountId: row.account_id,
    name: row.name,
    initialBalance: Number(row.initial_balance),
    balance: Number(row.balance)
  }));
}

export async function setTreasuryAccountActive(accountId: string, active: boolean): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("set_treasury_account_active", { p_account_id: accountId, p_active: active });
  if (error) throw error;
}

export interface AdjustTreasuryAccountInput {
  accountId: string;
  branchId: string;
  amount: number;
  direction: "in" | "out";
  reason: string;
}

export async function adjustTreasuryAccount(input: AdjustTreasuryAccountInput): Promise<{ id: string; balance: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("adjust_treasury_account", {
    p_account_id: input.accountId,
    p_branch_id: input.branchId,
    p_amount: input.amount,
    p_direction: input.direction,
    p_reason: input.reason
  });

  if (error) throw error;
  return { id: data.id, balance: Number(data.balance) };
}

export interface TransferTreasuryFundsInput {
  branchId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  reason?: string;
}

export async function transferTreasuryFunds(input: TransferTreasuryFundsInput): Promise<{ transferId: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("transfer_treasury_funds", {
    p_branch_id: input.branchId,
    p_from_account_id: input.fromAccountId,
    p_to_account_id: input.toAccountId,
    p_amount: input.amount,
    p_reason: input.reason ?? null
  });

  if (error) throw error;
  return { transferId: data.transfer_id };
}

export interface TreasuryMovementRow {
  id: string;
  accountName: string;
  direction: "in" | "out";
  amount: number;
  movementType: string;
  category: string | null;
  occurredOn: string;
  notes: string | null;
}

interface TreasuryMovementQueryRow {
  id: string;
  direction: "in" | "out";
  amount: number;
  movement_type: string;
  category: string | null;
  occurred_on: string;
  notes: string | null;
  treasury_accounts: { name: string } | null;
}

export interface ListTreasuryMovementsOptions {
  from?: string;
  to?: string;
  accountId?: string;
  limit?: number;
}

export async function listTreasuryMovements(options: ListTreasuryMovementsOptions = {}): Promise<TreasuryMovementRow[]> {
  if (!supabase) return [];

  let query = supabase
    .from("treasury_movements")
    .select("id,direction,amount,movement_type,category,occurred_on,notes,treasury_accounts(name)")
    .order("occurred_on", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(options.limit ?? 30);

  if (options.from) query = query.gte("occurred_on", options.from);
  if (options.to) query = query.lte("occurred_on", options.to);
  if (options.accountId) query = query.eq("account_id", options.accountId);

  const { data, error } = await query;

  if (error) throw error;
  return ((data ?? []) as unknown as TreasuryMovementQueryRow[]).map((row) => ({
    id: row.id,
    accountName: row.treasury_accounts?.name ?? "-",
    direction: row.direction,
    amount: Number(row.amount),
    movementType: row.movement_type,
    category: row.category,
    occurredOn: row.occurred_on,
    notes: row.notes
  }));
}

export type TreasuryExpenseCategory = "mantenimiento" | "servicios" | "impuestos" | "insumos" | "otro";

export interface RegisterTreasuryExpenseInput {
  branchId: string;
  accountId: string;
  amount: number;
  category: TreasuryExpenseCategory;
  description: string;
  expenseDate: string;
}

export async function registerTreasuryExpense(input: RegisterTreasuryExpenseInput): Promise<{ id: string; balance: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("register_treasury_expense", {
    p_branch_id: input.branchId,
    p_account_id: input.accountId,
    p_amount: input.amount,
    p_category: input.category,
    p_description: input.description,
    p_expense_date: input.expenseDate
  });

  if (error) throw error;
  return { id: data.id, balance: Number(data.balance) };
}

export async function deleteTreasuryExpense(movementId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_treasury_expense", { p_movement_id: movementId });
  if (error) throw error;
}
