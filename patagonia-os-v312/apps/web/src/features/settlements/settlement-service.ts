import { supabase } from "../../lib/supabase";
import { isCardDeposit } from "../reconciliation/reconcile-match";
import type { CardCredit, ReconCoverage, SaleDay, SettleAccount } from "./settlement";

/** Plata por entrar (migración 167). Dueño/administrador, plan Full. */

export interface SettlementAccountRow {
  id: string;
  name: string;
  /** null = sin condiciones cargadas. */
  days: number | null;
  feePct: number | null;
  reconId: string | null;
  reconName: string | null;
  isCard: boolean;
}

export interface FeeBooking {
  id: string;
  reconId: string;
  month: string;
  amount: number;
}

export interface SettlementData {
  rows: SettlementAccountRow[];
  /** Solo las cuentas con condiciones, listas para settle(). */
  accounts: SettleAccount[];
  sales: SaleDay[];
  cardCredits: CardCredit[];
  coverage: ReconCoverage[];
  reconNames: Record<string, string>;
  feeBookings: FeeBooking[];
}

function client() {
  if (!supabase) throw new Error("En modo demostración no se puede ver la plata por entrar.");
  return supabase;
}

export async function loadSettlementData(from: string): Promise<SettlementData> {
  const { data, error } = await client().rpc("get_settlement_data", { p_from: from });
  if (error) throw new Error(error.message);
  type A = { id: string; name: string; settle_days: number | null; settle_fee_pct: number | null };
  type R = { id: string; name: string; treasury_account_ids: string[]; card_account_ids: string[]; first_date: string | null; last_date: string | null };
  type S = { account_id: string; date: string; gross: number; gross_matched: number | null };
  type C = { recon_id: string; date: string; amount: number; description: string; card_deposit: boolean };
  type B = { id: string; recon_id: string; month: string; amount: number };

  const recons = (data?.recons ?? []) as R[];
  const rows: SettlementAccountRow[] = ((data?.accounts ?? []) as A[]).map((a) => {
    const recon = recons.find((r) => (r.treasury_account_ids ?? []).includes(a.id)) ?? null;
    return {
      id: a.id,
      name: a.name,
      days: a.settle_days === null ? null : Number(a.settle_days),
      feePct: a.settle_fee_pct === null ? null : Number(a.settle_fee_pct),
      reconId: recon?.id ?? null,
      reconName: recon?.name ?? null,
      isCard: Boolean(recon && (recon.card_account_ids ?? []).includes(a.id))
    };
  });

  return {
    rows,
    accounts: rows
      .filter((r) => r.days !== null)
      .map((r) => ({ id: r.id, name: r.name, days: r.days!, feePct: r.feePct ?? 0, reconId: r.reconId, isCard: r.isCard })),
    sales: ((data?.sales ?? []) as S[]).map((s) => ({ accountId: s.account_id, date: s.date, gross: Number(s.gross), grossMatched: Number(s.gross_matched ?? 0) })),
    // Mismo criterio que Conciliación: las ya marcadas como tarjetas, o las pendientes que parecen de tarjetas.
    cardCredits: ((data?.credits ?? []) as C[])
      .filter((c) => c.card_deposit || isCardDeposit({ amount: Number(c.amount), description: c.description }))
      .map((c) => ({ reconId: c.recon_id, date: c.date, amount: Number(c.amount) })),
    coverage: recons.map((r) => ({ reconId: r.id, firstDate: r.first_date, lastDate: r.last_date })),
    reconNames: Object.fromEntries(recons.map((r) => [r.id, r.name])),
    feeBookings: ((data?.fee_bookings ?? []) as B[]).map((b) => ({ id: b.id, reconId: b.recon_id, month: b.month, amount: Number(b.amount) }))
  };
}

/** days null = sin condiciones (no se sigue). */
export async function setAccountSettlement(accountId: string, days: number | null, feePct: number | null): Promise<void> {
  const { error } = await client().rpc("set_treasury_account_settlement", { p_account_id: accountId, p_days: days, p_fee_pct: feePct });
  if (error) throw new Error(error.message);
}

export async function bookCardFees(reconId: string, month: string, amount: number, branchId: string): Promise<void> {
  const { error } = await client().rpc("book_card_fees", { p_recon_account_id: reconId, p_month: month, p_amount: amount, p_branch_id: branchId });
  if (error) throw new Error(error.message);
}

export async function undoCardFeeBooking(bookingId: string): Promise<void> {
  const { error } = await client().rpc("undo_card_fee_booking", { p_booking_id: bookingId });
  if (error) throw new Error(error.message);
}
