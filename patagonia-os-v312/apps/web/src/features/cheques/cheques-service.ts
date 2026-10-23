import { supabase } from "../../lib/supabase";
import type { Cheque, ChequeKind, ChequeStatus } from "./cheque-logic";

// Cheques (migración 150, plan Full): la tabla se lee directo (RLS por
// empresa + plan) y todo cambio pasa por las funciones de la base.

interface ChequeRow {
  id: string;
  kind: ChequeKind;
  echeq: boolean;
  number: string;
  bank: string | null;
  drawer_name: string | null;
  drawer_cuit: string | null;
  amount: number | string;
  pay_date: string;
  status: ChequeStatus;
  step_date: string | null;
  notes: string | null;
  created_at: string;
  customers: { name: string } | null;
  suppliers: { name: string } | null;
  treasury_accounts: { name: string } | null;
}

function requireClient() {
  if (!supabase) throw new Error("Supabase no está configurado.");
  return supabase;
}

export async function listCheques(): Promise<Cheque[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("cheques")
    .select("id,kind,echeq,number,bank,drawer_name,drawer_cuit,amount,pay_date,status,step_date,notes,created_at,customers(name),suppliers(name),treasury_accounts(name)")
    .order("pay_date")
    .limit(1000);
  if (error) throw error;
  return ((data ?? []) as unknown as ChequeRow[]).map((r) => ({
    id: r.id,
    kind: r.kind,
    echeq: r.echeq,
    number: r.number,
    bank: r.bank,
    drawerName: r.drawer_name,
    drawerCuit: r.drawer_cuit,
    amount: Number(r.amount),
    payDate: r.pay_date,
    status: r.status,
    customerName: r.customers?.name ?? null,
    supplierName: r.suppliers?.name ?? null,
    bankAccountName: r.treasury_accounts?.name ?? null,
    stepDate: r.step_date,
    notes: r.notes,
    createdAt: r.created_at
  }));
}

/** Solo los abiertos, para los avisos de Inicio. */
export async function listOpenCheques(): Promise<Cheque[]> {
  return (await listCheques()).filter((c) => c.status === "in_portfolio" || c.status === "pending");
}

export interface ChequeData {
  number: string;
  bank?: string;
  amount: number;
  payDate: string;
  echeq: boolean;
  notes?: string;
}

export async function receiveCustomerCheque(input: ChequeData & {
  customerId: string;
  branchId: string;
  receivedOn: string;
  drawerName?: string;
  drawerCuit?: string;
}): Promise<{ id: string; balance: number | null }> {
  const { data, error } = await requireClient().rpc("receive_customer_cheque", {
    p_customer_id: input.customerId,
    p_branch_id: input.branchId,
    p_received_on: input.receivedOn,
    p_amount: input.amount,
    p_number: input.number,
    p_bank: input.bank ?? null,
    p_drawer_name: input.drawerName ?? null,
    p_drawer_cuit: input.drawerCuit ?? null,
    p_pay_date: input.payDate,
    p_echeq: input.echeq,
    p_notes: input.notes ?? null
  });
  if (error) throw error;
  const r = data as { id: string; balance: number | null };
  return { id: r.id, balance: r.balance === null ? null : Number(r.balance) };
}

export async function issueCheque(input: ChequeData & {
  supplierId: string;
  branchId: string;
  issuedOn: string;
  bankAccountId: string;
}): Promise<void> {
  const { error } = await requireClient().rpc("issue_cheque", {
    p_supplier_id: input.supplierId,
    p_branch_id: input.branchId,
    p_issued_on: input.issuedOn,
    p_amount: input.amount,
    p_number: input.number,
    p_bank_account_id: input.bankAccountId,
    p_pay_date: input.payDate,
    p_echeq: input.echeq,
    p_notes: input.notes ?? null
  });
  if (error) throw error;
}

export async function depositCheque(chequeId: string, accountId: string, date: string): Promise<void> {
  const { error } = await requireClient().rpc("deposit_cheque", { p_cheque_id: chequeId, p_account_id: accountId, p_date: date });
  if (error) throw error;
}

export async function endorseCheque(chequeId: string, supplierId: string, branchId: string, date: string): Promise<void> {
  const { error } = await requireClient().rpc("endorse_cheque", { p_cheque_id: chequeId, p_supplier_id: supplierId, p_branch_id: branchId, p_date: date });
  if (error) throw error;
}

export async function rejectCheque(chequeId: string, date: string, notes: string): Promise<void> {
  const { error } = await requireClient().rpc("reject_cheque", { p_cheque_id: chequeId, p_date: date, p_notes: notes || null });
  if (error) throw error;
}

export async function markChequeDebited(chequeId: string, date: string): Promise<void> {
  const { error } = await requireClient().rpc("mark_cheque_debited", { p_cheque_id: chequeId, p_date: date });
  if (error) throw error;
}

export async function undoChequeStep(chequeId: string): Promise<void> {
  const { error } = await requireClient().rpc("undo_cheque_step", { p_cheque_id: chequeId });
  if (error) throw error;
}
