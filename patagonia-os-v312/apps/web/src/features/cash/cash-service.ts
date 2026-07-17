import type { CashSession } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

export interface OpenCashSessionInput {
  branchId: string;
  openingAmount: number;
}

export interface CloseCashSessionInput {
  branchId: string;
  closingCounted: number;
}

export interface CloseCashSessionResult extends CashSession {
  expectedCash: number;
}

interface CashSessionRow {
  id: string;
  branch_id: string;
  status: "open" | "closed";
  opening_amount: number;
  opened_at: string;
  opened_by: string;
  closing_counted?: number | null;
  difference?: number | null;
  closed_at?: string | null;
}

function mapRow(row: CashSessionRow): CashSession {
  return {
    id: row.id,
    branchId: row.branch_id,
    status: row.status,
    openingAmount: row.opening_amount,
    openedAt: row.opened_at,
    openedBy: row.opened_by,
    closingCounted: row.closing_counted ?? undefined,
    difference: row.difference ?? undefined,
    closedAt: row.closed_at ?? undefined
  };
}

export async function openCashSession(input: OpenCashSessionInput): Promise<CashSession> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("open_cash_session", {
    p_branch_id: input.branchId,
    p_opening_amount: input.openingAmount
  });

  if (error) throw error;
  return mapRow(data as CashSessionRow);
}

export async function closeCashSession(input: CloseCashSessionInput): Promise<CloseCashSessionResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("close_cash_session", {
    p_branch_id: input.branchId,
    p_closing_counted: input.closingCounted
  });

  if (error) throw error;
  return { ...mapRow(data as CashSessionRow), expectedCash: data.expected };
}

export async function fetchOpenCashSession(branchId: string): Promise<CashSession | null> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase
    .from("cash_sessions")
    .select("id,branch_id,status,opening_amount,opened_at,opened_by")
    .eq("branch_id", branchId)
    .eq("status", "open")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return mapRow(data as CashSessionRow);
}
