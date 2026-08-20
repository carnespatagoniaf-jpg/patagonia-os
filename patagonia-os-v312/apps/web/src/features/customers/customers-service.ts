import type { Customer, CustomerBalance, CustomerCharge, CustomerPayment } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

interface CustomerRow {
  id: string;
  branch_id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  active: boolean;
}

function mapCustomer(row: CustomerRow): Customer {
  return { id: row.id, branchId: row.branch_id, name: row.name, phone: row.phone ?? undefined, notes: row.notes ?? undefined, active: row.active };
}

export async function listCustomers(includeInactive = false): Promise<Customer[]> {
  if (!supabase) return [];

  let query = supabase.from("customers").select("id,branch_id,name,phone,notes,active").order("name");
  if (!includeInactive) query = query.eq("active", true);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapCustomer);
}

export interface CreateCustomerInput {
  branchId: string;
  name: string;
  phone?: string;
  notes?: string;
}

export async function createCustomer(input: CreateCustomerInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_customer", {
    p_branch_id: input.branchId,
    p_name: input.name,
    p_phone: input.phone ?? null,
    p_notes: input.notes ?? null
  });

  if (error) throw error;
  return { id: data.id };
}

interface CustomerChargeRow {
  id: string;
  customer_id: string;
  charge_date: string;
  amount: number;
  reason: string;
  created_at: string;
}

function mapCharge(row: CustomerChargeRow): CustomerCharge {
  return { id: row.id, customerId: row.customer_id, chargeDate: row.charge_date, amount: Number(row.amount), reason: row.reason, createdAt: row.created_at };
}

export async function listCustomerCharges(customerId: string): Promise<CustomerCharge[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("customer_charges")
    .select("id,customer_id,charge_date,amount,reason,created_at")
    .eq("customer_id", customerId)
    .order("charge_date", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(mapCharge);
}

export interface CreateCustomerChargeInput {
  customerId: string;
  chargeDate: string;
  amount: number;
  reason: string;
}

export async function createCustomerCharge(input: CreateCustomerChargeInput): Promise<{ id: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_customer_charge", {
    p_customer_id: input.customerId,
    p_charge_date: input.chargeDate,
    p_amount: input.amount,
    p_reason: input.reason
  });

  if (error) throw error;
  return { id: data.id };
}

export interface UpdateCustomerChargeInput {
  id: string;
  chargeDate: string;
  amount: number;
  reason: string;
}

export async function updateCustomerCharge(input: UpdateCustomerChargeInput): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("update_customer_charge", {
    p_charge_id: input.id,
    p_charge_date: input.chargeDate,
    p_amount: input.amount,
    p_reason: input.reason
  });
  if (error) throw error;
}

export async function deleteCustomerCharge(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_customer_charge", { p_charge_id: id });
  if (error) throw error;
}

interface CustomerPaymentRow {
  id: string;
  customer_id: string;
  payment_date: string;
  amount: number;
  account_id: string;
  notes: string | null;
  created_at: string;
  treasury_accounts: { name: string } | null;
}

function mapPayment(row: CustomerPaymentRow): CustomerPayment {
  return {
    id: row.id,
    customerId: row.customer_id,
    paymentDate: row.payment_date,
    amount: Number(row.amount),
    accountId: row.account_id,
    accountName: row.treasury_accounts?.name,
    notes: row.notes ?? undefined,
    createdAt: row.created_at
  };
}

export async function listCustomerPayments(customerId: string): Promise<CustomerPayment[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("customer_payments")
    .select("id,customer_id,payment_date,amount,account_id,notes,created_at,treasury_accounts(name)")
    .eq("customer_id", customerId)
    .order("payment_date", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as unknown as CustomerPaymentRow[]).map(mapPayment);
}

export interface RegisterCustomerPaymentInput {
  customerId: string;
  branchId: string;
  paymentDate: string;
  amount: number;
  accountId: string;
  notes?: string;
}

export async function registerCustomerPayment(input: RegisterCustomerPaymentInput): Promise<{ id: string; balance: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("register_customer_payment", {
    p_customer_id: input.customerId,
    p_branch_id: input.branchId,
    p_payment_date: input.paymentDate,
    p_amount: input.amount,
    p_account_id: input.accountId,
    p_notes: input.notes ?? null
  });

  if (error) throw error;
  return { id: data.id, balance: Number(data.balance) };
}

export interface UpdateCustomerPaymentInput {
  id: string;
  paymentDate: string;
  amount: number;
  accountId: string;
  notes?: string;
}

export async function updateCustomerPayment(input: UpdateCustomerPaymentInput): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("update_customer_payment", {
    p_payment_id: input.id,
    p_payment_date: input.paymentDate,
    p_amount: input.amount,
    p_account_id: input.accountId,
    p_notes: input.notes ?? null
  });
  if (error) throw error;
}

export async function deleteCustomerPayment(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_customer_payment", { p_payment_id: id });
  if (error) throw error;
}

export async function getCustomerBalance(customerId: string): Promise<CustomerBalance | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("customer_balance")
    .select("customer_id,total_charged,total_paid,balance")
    .eq("customer_id", customerId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { customerId: data.customer_id, totalCharged: Number(data.total_charged), totalPaid: Number(data.total_paid), balance: Number(data.balance) };
}
