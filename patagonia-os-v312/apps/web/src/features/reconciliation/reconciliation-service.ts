import { supabase } from "../../lib/supabase";
import type { BankLine, BankMapping } from "./bank-statement";
import type { BankRule, RuleAction } from "./reconcile-match";

/** Conciliación bancaria (migración 103). Lecturas por RLS (dueño/admin), escrituras por RPC. */

export interface ReconAccount {
  id: string;
  name: string;
  treasuryAccountIds: string[];
  cardAccountIds: string[];
  mainTreasuryAccountId: string;
  mapping: BankMapping | null;
}

export interface StoredBankLine {
  id: string;
  date: string;
  description: string;
  amount: number;
  reference: string | null;
  balance: number | null;
  status: "pending" | "matched" | "ignored";
  matchKind: "card_deposit" | null;
  movementIds: string[];
  paymentIds: string[];
  createdMovementId: string | null;
}

export interface ReconPayment {
  id: string;
  date: string;
  accountId: string;
  amount: number;
  reference: string | null;
  reconciled: boolean;
}

export interface ReconMovement {
  id: string;
  date: string;
  accountId: string;
  direction: "in" | "out";
  amount: number;
  type: string;
  notes: string | null;
  reconciled: boolean;
}

function client() {
  if (!supabase) throw new Error("En modo demostración no se puede conciliar.");
  return supabase;
}

export async function listReconAccounts(): Promise<ReconAccount[]> {
  const { data, error } = await client()
    .from("bank_reconciliation_accounts")
    .select("id,name,treasury_account_ids,card_account_ids,main_treasury_account_id,mapping")
    .order("name");
  if (error) throw error;
  type Row = { id: string; name: string; treasury_account_ids: string[]; card_account_ids: string[]; main_treasury_account_id: string; mapping: BankMapping | null };
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    name: r.name,
    treasuryAccountIds: r.treasury_account_ids ?? [],
    cardAccountIds: r.card_account_ids ?? [],
    mainTreasuryAccountId: r.main_treasury_account_id,
    mapping: r.mapping
  }));
}

export async function saveReconAccount(input: { id: string | null; name: string; treasuryAccountIds: string[]; cardAccountIds: string[]; mainTreasuryAccountId: string }): Promise<string> {
  const { data, error } = await client().rpc("save_reconciliation_account", {
    p_id: input.id,
    p_name: input.name,
    p_treasury_account_ids: input.treasuryAccountIds,
    p_card_account_ids: input.cardAccountIds,
    p_main_treasury_account_id: input.mainTreasuryAccountId
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function importBankStatement(reconAccountId: string, fileName: string, mapping: BankMapping, lines: BankLine[]): Promise<{ new: number; repeated: number }> {
  const { data, error } = await client().rpc("import_bank_statement", {
    p_recon_account_id: reconAccountId,
    p_file_name: fileName,
    p_mapping: mapping,
    p_lines: lines.map((l) => ({ date: l.date, description: l.description, amount: l.amount, reference: l.reference, balance: l.balance, key: l.key }))
  });
  if (error) throw new Error(error.message);
  return { new: Number(data.new), repeated: Number(data.repeated) };
}

export async function listBankLines(reconAccountId: string, from: string, to: string): Promise<StoredBankLine[]> {
  const { data, error } = await client()
    .from("bank_statement_lines")
    .select("id,line_date,description,amount,reference,balance,status,match_kind,created_movement_id,bank_line_matches(movement_id,payment_id)")
    .eq("recon_account_id", reconAccountId)
    .gte("line_date", from)
    .lte("line_date", to)
    .order("line_date")
    .limit(10000);
  if (error) throw error;
  type Row = {
    id: string; line_date: string; description: string; amount: number; reference: string | null; balance: number | null;
    status: StoredBankLine["status"]; match_kind: StoredBankLine["matchKind"]; created_movement_id: string | null;
    bank_line_matches: { movement_id: string | null; payment_id: string | null }[] | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    date: r.line_date,
    description: r.description,
    amount: Number(r.amount),
    reference: r.reference,
    balance: r.balance === null ? null : Number(r.balance),
    status: r.status,
    matchKind: r.match_kind,
    movementIds: (r.bank_line_matches ?? []).map((m) => m.movement_id).filter((x): x is string => Boolean(x)),
    paymentIds: (r.bank_line_matches ?? []).map((m) => m.payment_id).filter((x): x is string => Boolean(x)),
    createdMovementId: r.created_movement_id
  }));
}

export async function getReconciliationItems(reconAccountId: string, from: string, to: string): Promise<{ payments: ReconPayment[]; movements: ReconMovement[] }> {
  const { data, error } = await client().rpc("get_reconciliation_items", { p_recon_account_id: reconAccountId, p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  type P = { id: string; date: string; account_id: string; amount: number; reference: string | null; reconciled: boolean };
  type M = { id: string; date: string; account_id: string; direction: "in" | "out"; amount: number; type: string; notes: string | null; reconciled: boolean };
  return {
    payments: ((data?.payments ?? []) as P[]).map((p) => ({ id: p.id, date: p.date, accountId: p.account_id, amount: Number(p.amount), reference: p.reference, reconciled: p.reconciled })),
    movements: ((data?.movements ?? []) as M[]).map((m) => ({
      id: m.id, date: m.date, accountId: m.account_id, direction: m.direction, amount: Number(m.amount), type: m.type, notes: m.notes, reconciled: m.reconciled
    }))
  };
}

/** adjustment: diferencia banco − sistema de una coincidencia "casi igual" (se registra como ajuste, migración 105). */
export async function confirmBankMatch(lineId: string, movementIds: string[], paymentIds: string[], fee: number, adjustment = 0): Promise<void> {
  const { error } = await client().rpc("confirm_bank_match", { p_line_id: lineId, p_movement_ids: movementIds, p_payment_ids: paymentIds, p_fee: fee, p_adjustment: adjustment });
  if (error) throw new Error(error.message);
}

/** Muchas coincidencias en un solo pedido (todo o nada). */
export async function confirmBankMatches(matches: { lineId: string; movementIds: string[]; paymentIds: string[]; adjustment?: number }[]): Promise<number> {
  const { data, error } = await client().rpc("confirm_bank_matches", {
    p_matches: matches.map((m) => ({ line_id: m.lineId, movement_ids: m.movementIds, payment_ids: m.paymentIds, adjustment: m.adjustment ?? 0 }))
  });
  if (error) throw new Error(error.message);
  return Number(data);
}

export async function markCardDeposits(lineIds: string[]): Promise<number> {
  const { data, error } = await client().rpc("mark_bank_lines_card_deposit", { p_line_ids: lineIds });
  if (error) throw new Error(error.message);
  return Number(data);
}

export async function createMovementFromBankLine(lineId: string, branchId: string, category: string, notes: string): Promise<void> {
  const { error } = await client().rpc("create_movement_from_bank_line", { p_line_id: lineId, p_branch_id: branchId, p_category: category, p_notes: notes });
  if (error) throw new Error(error.message);
}

export async function createMovementsFromBankLines(lineIds: string[], branchId: string, category: string): Promise<number> {
  const { data, error } = await client().rpc("create_movements_from_bank_lines", { p_line_ids: lineIds, p_branch_id: branchId, p_category: category });
  if (error) throw new Error(error.message);
  return Number(data);
}

export async function setBankLineIgnored(lineId: string, ignored: boolean): Promise<void> {
  const { error } = await client().rpc("set_bank_line_ignored", { p_line_id: lineId, p_ignored: ignored });
  if (error) throw new Error(error.message);
}

export async function undoBankMatch(lineId: string): Promise<void> {
  const { error } = await client().rpc("undo_bank_match", { p_line_id: lineId });
  if (error) throw new Error(error.message);
}

/* ------------------------------ migración 106 ------------------------------ */

/** Una línea del banco que es un cobro de cliente (ej. un DEBIN): baja su deuda como Clientes → Registrar pago. */
export async function createCustomerPaymentFromBankLine(lineId: string, customerId: string, branchId: string): Promise<void> {
  const { error } = await client().rpc("create_customer_payment_from_bank_line", { p_line_id: lineId, p_customer_id: customerId, p_branch_id: branchId });
  if (error) throw new Error(error.message);
}

export async function listReconRules(reconAccountId: string): Promise<BankRule[]> {
  const { data, error } = await client()
    .from("bank_reconciliation_rules")
    .select("id,match_text,direction,action,category,customer_id")
    .eq("recon_account_id", reconAccountId)
    .order("created_at");
  if (error) throw error;
  type Row = { id: string; match_text: string; direction: "in" | "out"; action: RuleAction; category: string | null; customer_id: string | null };
  return ((data ?? []) as Row[]).map((r) => ({ id: r.id, matchText: r.match_text, direction: r.direction, action: r.action, category: r.category, customerId: r.customer_id }));
}

export async function saveReconRule(reconAccountId: string, rule: Omit<BankRule, "id">): Promise<string> {
  const { data, error } = await client().rpc("save_reconciliation_rule", {
    p_recon_account_id: reconAccountId,
    p_match_text: rule.matchText,
    p_direction: rule.direction,
    p_action: rule.action,
    p_category: rule.category,
    p_customer_id: rule.customerId
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function deleteReconRule(ruleId: string): Promise<void> {
  const { error } = await client().rpc("delete_reconciliation_rule", { p_rule_id: ruleId });
  if (error) throw new Error(error.message);
}

/** Todo o nada: la base verifica que cada regla corresponda a su línea. */
export async function applyReconRules(items: { lineId: string; ruleId: string }[], branchId: string): Promise<number> {
  const { data, error } = await client().rpc("apply_reconciliation_rules", {
    p_items: items.map((i) => ({ line_id: i.lineId, rule_id: i.ruleId })),
    p_branch_id: branchId
  });
  if (error) throw new Error(error.message);
  return Number(data);
}

export interface TransferAlert {
  id: string;
  reconAccountId: string;
  reconAccountName: string;
  date: string;
  time: string;
  amount: number;
  accountName: string;
  reference: string | null;
  cashier: string;
  branchName: string | null;
}

/**
 * Cobros de Mostrador (no tarjeta) que ya deberían verse en el banco y no
 * aparecen (ni parecidos). reconAccountId null = todas las cuentas del banco.
 */
export async function getTransferAlerts(reconAccountId: string | null): Promise<TransferAlert[]> {
  const { data, error } = await client().rpc("get_reconciliation_alerts", { p_recon_account_id: reconAccountId });
  if (error) throw new Error(error.message);
  type Row = { id: string; recon_account_id: string; recon_account_name: string; date: string; time: string; amount: number; account_name: string | null; reference: string | null; cashier: string; branch_name: string | null };
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    reconAccountId: r.recon_account_id,
    reconAccountName: r.recon_account_name,
    date: r.date,
    time: r.time,
    amount: Number(r.amount),
    accountName: r.account_name ?? "",
    reference: r.reference,
    cashier: r.cashier,
    branchName: r.branch_name
  }));
}

export async function getSystemBalance(reconAccountId: string, date: string): Promise<number> {
  const { data, error } = await client().rpc("reconciliation_system_balance", { p_recon_account_id: reconAccountId, p_date: date });
  if (error) throw new Error(error.message);
  return Number(data);
}

export interface ReconClose {
  id: string;
  periodFrom: string;
  periodEnd: string;
  bankBalance: number;
  systemBalance: number;
  detail: Record<string, unknown>;
  closedAt: string;
}

export async function listReconCloses(reconAccountId: string): Promise<ReconClose[]> {
  const { data, error } = await client()
    .from("bank_reconciliation_closes")
    .select("id,period_from,period_end,bank_balance,system_balance,detail,closed_at")
    .eq("recon_account_id", reconAccountId)
    .order("period_end", { ascending: false });
  if (error) throw error;
  type Row = { id: string; period_from: string; period_end: string; bank_balance: number; system_balance: number; detail: Record<string, unknown> | null; closed_at: string };
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    periodFrom: r.period_from,
    periodEnd: r.period_end,
    bankBalance: Number(r.bank_balance),
    systemBalance: Number(r.system_balance),
    detail: r.detail ?? {},
    closedAt: r.closed_at
  }));
}

export async function closeReconPeriod(reconAccountId: string, from: string, to: string, bankBalance: number, detail: Record<string, unknown>): Promise<void> {
  const { error } = await client().rpc("close_reconciliation_period", {
    p_recon_account_id: reconAccountId,
    p_period_from: from,
    p_period_end: to,
    p_bank_balance: bankBalance,
    p_detail: detail
  });
  if (error) throw new Error(error.message);
}

export async function reopenReconPeriod(closeId: string): Promise<void> {
  const { error } = await client().rpc("reopen_reconciliation_period", { p_close_id: closeId });
  if (error) throw new Error(error.message);
}
