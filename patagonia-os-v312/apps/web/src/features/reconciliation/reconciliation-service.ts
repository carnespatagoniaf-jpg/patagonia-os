import { supabase } from "../../lib/supabase";
import type { BankLine, BankMapping } from "./bank-statement";

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
    .select("id,line_date,description,amount,reference,status,match_kind,created_movement_id,bank_line_matches(movement_id,payment_id)")
    .eq("recon_account_id", reconAccountId)
    .gte("line_date", from)
    .lte("line_date", to)
    .order("line_date")
    .limit(10000);
  if (error) throw error;
  type Row = {
    id: string; line_date: string; description: string; amount: number; reference: string | null;
    status: StoredBankLine["status"]; match_kind: StoredBankLine["matchKind"]; created_movement_id: string | null;
    bank_line_matches: { movement_id: string | null; payment_id: string | null }[] | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    date: r.line_date,
    description: r.description,
    amount: Number(r.amount),
    reference: r.reference,
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

export async function confirmBankMatch(lineId: string, movementIds: string[], paymentIds: string[], fee: number): Promise<void> {
  const { error } = await client().rpc("confirm_bank_match", { p_line_id: lineId, p_movement_ids: movementIds, p_payment_ids: paymentIds, p_fee: fee });
  if (error) throw new Error(error.message);
}

/** Muchas coincidencias en un solo pedido (todo o nada). */
export async function confirmBankMatches(matches: { lineId: string; movementIds: string[]; paymentIds: string[] }[]): Promise<number> {
  const { data, error } = await client().rpc("confirm_bank_matches", {
    p_matches: matches.map((m) => ({ line_id: m.lineId, movement_ids: m.movementIds, payment_ids: m.paymentIds }))
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
