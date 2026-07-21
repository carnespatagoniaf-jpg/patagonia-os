import type { Creditor, CreditorBalance, CreditorDebt, CreditorPayment } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

interface CreditorRow {
  id: string;
  branch_id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  active: boolean;
}

function mapCreditor(row: CreditorRow): Creditor {
  return { id: row.id, branchId: row.branch_id, name: row.name, phone: row.phone ?? undefined, notes: row.notes ?? undefined, active: row.active };
}

export async function listCreditors(includeInactive = false): Promise<Creditor[]> {
  if (!supabase) return [];

  let query = supabase.from("creditors").select("id,branch_id,name,phone,notes,active").order("name");
  if (!includeInactive) query = query.eq("active", true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapCreditor);
}

export interface CreateCreditorInput {
  branchId: string;
  name: string;
  phone?: string;
  notes?: string;
}

export async function createCreditor(input: CreateCreditorInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_creditor", {
    p_branch_id: input.branchId,
    p_name: input.name,
    p_phone: input.phone ?? null,
    p_notes: input.notes ?? null
  });

  if (error) throw error;
  return { id: data.id };
}

interface CreditorDebtRow {
  id: string;
  creditor_id: string;
  debt_date: string;
  amount: number;
  reason: string;
  account_id: string | null;
  created_at: string;
  treasury_accounts: { name: string } | null;
}

function mapDebt(row: CreditorDebtRow): CreditorDebt {
  return {
    id: row.id,
    creditorId: row.creditor_id,
    debtDate: row.debt_date,
    amount: Number(row.amount),
    reason: row.reason,
    accountId: row.account_id ?? undefined,
    accountName: row.treasury_accounts?.name,
    createdAt: row.created_at
  };
}

export async function listCreditorDebts(creditorId: string): Promise<CreditorDebt[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("creditor_debts")
    .select("id,creditor_id,debt_date,amount,reason,account_id,created_at,treasury_accounts(name)")
    .eq("creditor_id", creditorId)
    .order("debt_date", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as unknown as CreditorDebtRow[]).map(mapDebt);
}

export interface CreateCreditorDebtInput {
  creditorId: string;
  debtDate: string;
  amount: number;
  reason: string;
  accountId?: string;
}

export async function createCreditorDebt(input: CreateCreditorDebtInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_creditor_debt", {
    p_creditor_id: input.creditorId,
    p_debt_date: input.debtDate,
    p_amount: input.amount,
    p_reason: input.reason,
    p_account_id: input.accountId ?? null
  });

  if (error) throw error;
  return { id: data.id };
}

export interface UpdateCreditorDebtInput {
  id: string;
  debtDate: string;
  amount: number;
  reason: string;
  accountId?: string;
}

export async function updateCreditorDebt(input: UpdateCreditorDebtInput): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("update_creditor_debt", {
    p_debt_id: input.id,
    p_debt_date: input.debtDate,
    p_amount: input.amount,
    p_reason: input.reason,
    p_account_id: input.accountId ?? null
  });
  if (error) throw error;
}

export async function deleteCreditorDebt(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_creditor_debt", { p_debt_id: id });
  if (error) throw error;
}

interface CreditorPaymentRow {
  id: string;
  creditor_id: string;
  payment_date: string;
  amount: number;
  account_id: string;
  notes: string | null;
  created_at: string;
  treasury_accounts: { name: string } | null;
}

function mapPayment(row: CreditorPaymentRow): CreditorPayment {
  return {
    id: row.id,
    creditorId: row.creditor_id,
    paymentDate: row.payment_date,
    amount: Number(row.amount),
    accountId: row.account_id,
    accountName: row.treasury_accounts?.name,
    notes: row.notes ?? undefined,
    createdAt: row.created_at
  };
}

export async function listCreditorPayments(creditorId: string): Promise<CreditorPayment[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("creditor_payments")
    .select("id,creditor_id,payment_date,amount,account_id,notes,created_at,treasury_accounts(name)")
    .eq("creditor_id", creditorId)
    .order("payment_date", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as unknown as CreditorPaymentRow[]).map(mapPayment);
}

export interface RegisterCreditorPaymentInput {
  creditorId: string;
  branchId: string;
  paymentDate: string;
  amount: number;
  accountId: string;
  notes?: string;
}

export async function registerCreditorPayment(input: RegisterCreditorPaymentInput): Promise<{ id: string; balance: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("register_creditor_payment", {
    p_creditor_id: input.creditorId,
    p_branch_id: input.branchId,
    p_payment_date: input.paymentDate,
    p_amount: input.amount,
    p_account_id: input.accountId,
    p_notes: input.notes ?? null
  });

  if (error) throw error;
  return { id: data.id, balance: Number(data.balance) };
}

export interface UpdateCreditorPaymentInput {
  id: string;
  paymentDate: string;
  amount: number;
  accountId: string;
  notes?: string;
}

export async function updateCreditorPayment(input: UpdateCreditorPaymentInput): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("update_creditor_payment", {
    p_payment_id: input.id,
    p_payment_date: input.paymentDate,
    p_amount: input.amount,
    p_account_id: input.accountId,
    p_notes: input.notes ?? null
  });
  if (error) throw error;
}

export async function deleteCreditorPayment(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_creditor_payment", { p_payment_id: id });
  if (error) throw error;
}

export async function getCreditorBalance(creditorId: string): Promise<CreditorBalance | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("creditor_balance")
    .select("creditor_id,total_debt,total_paid,balance")
    .eq("creditor_id", creditorId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { creditorId: data.creditor_id, totalDebt: Number(data.total_debt), totalPaid: Number(data.total_paid), balance: Number(data.balance) };
}
