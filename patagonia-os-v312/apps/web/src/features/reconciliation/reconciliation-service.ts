import { supabase } from "../../lib/supabase";
import type { BankLine, BankMapping } from "./bank-statement";

/** Conciliación bancaria (migración 103). Lecturas por RLS (dueño/admin), escrituras por RPC. */

export interface StoredBankLine {
  id: string;
  date: string;
  description: string;
  amount: number;
  reference: string | null;
  status: "pending" | "matched" | "ignored";
  movementIds: string[];
  createdMovementId: string | null;
}

export interface AccountMovement {
  id: string;
  date: string;
  direction: "in" | "out";
  amount: number;
  movementType: string;
  notes: string | null;
  reconciled: boolean;
}

function client() {
  if (!supabase) throw new Error("En modo demostración no se puede conciliar.");
  return supabase;
}

export async function getSavedBankFormat(accountId: string): Promise<BankMapping | null> {
  const { data, error } = await client().from("bank_statement_formats").select("mapping").eq("account_id", accountId).maybeSingle();
  if (error) throw error;
  return (data?.mapping as BankMapping | undefined) ?? null;
}

export async function importBankStatement(accountId: string, fileName: string, mapping: BankMapping, lines: BankLine[]): Promise<{ new: number; repeated: number }> {
  const { data, error } = await client().rpc("import_bank_statement", {
    p_account_id: accountId,
    p_file_name: fileName,
    p_mapping: mapping,
    p_lines: lines.map((l) => ({ date: l.date, description: l.description, amount: l.amount, reference: l.reference, balance: l.balance, key: l.key }))
  });
  if (error) throw new Error(error.message);
  return { new: Number(data.new), repeated: Number(data.repeated) };
}

export async function listBankLines(accountId: string, from: string, to: string): Promise<StoredBankLine[]> {
  const { data, error } = await client()
    .from("bank_statement_lines")
    .select("id,line_date,description,amount,reference,status,created_movement_id,bank_line_matches(movement_id)")
    .eq("account_id", accountId)
    .gte("line_date", from)
    .lte("line_date", to)
    .order("line_date")
    .limit(5000);
  if (error) throw error;
  type Row = {
    id: string; line_date: string; description: string; amount: number; reference: string | null;
    status: StoredBankLine["status"]; created_movement_id: string | null; bank_line_matches: { movement_id: string }[] | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    date: r.line_date,
    description: r.description,
    amount: Number(r.amount),
    reference: r.reference,
    status: r.status,
    movementIds: (r.bank_line_matches ?? []).map((m) => m.movement_id),
    createdMovementId: r.created_movement_id
  }));
}

/** Movimientos de la cuenta en el período (desde un poco antes: las tarjetas acreditan días después). */
export async function listAccountMovements(accountId: string, from: string, to: string): Promise<AccountMovement[]> {
  const { data, error } = await client()
    .from("treasury_movements")
    .select("id,occurred_on,direction,amount,movement_type,notes,bank_line_matches(line_id)")
    .eq("account_id", accountId)
    .gte("occurred_on", from)
    .lte("occurred_on", to)
    .order("occurred_on")
    .limit(5000);
  if (error) throw error;
  type Row = {
    id: string; occurred_on: string; direction: "in" | "out"; amount: number; movement_type: string; notes: string | null;
    bank_line_matches: { line_id: string }[] | { line_id: string } | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => {
    const matches = r.bank_line_matches;
    const reconciled = Array.isArray(matches) ? matches.length > 0 : Boolean(matches);
    return {
      id: r.id,
      date: r.occurred_on,
      direction: r.direction,
      amount: Number(r.amount),
      movementType: r.movement_type,
      notes: r.notes,
      reconciled
    };
  });
}

export async function confirmBankMatch(lineId: string, movementIds: string[], fee: number): Promise<void> {
  const { error } = await client().rpc("confirm_bank_match", { p_line_id: lineId, p_movement_ids: movementIds, p_fee: fee });
  if (error) throw new Error(error.message);
}

export async function createMovementFromBankLine(lineId: string, branchId: string, category: string, notes: string): Promise<void> {
  const { error } = await client().rpc("create_movement_from_bank_line", { p_line_id: lineId, p_branch_id: branchId, p_category: category, p_notes: notes });
  if (error) throw new Error(error.message);
}

export async function setBankLineIgnored(lineId: string, ignored: boolean): Promise<void> {
  const { error } = await client().rpc("set_bank_line_ignored", { p_line_id: lineId, p_ignored: ignored });
  if (error) throw new Error(error.message);
}

export async function undoBankMatch(lineId: string): Promise<void> {
  const { error } = await client().rpc("undo_bank_match", { p_line_id: lineId });
  if (error) throw new Error(error.message);
}
