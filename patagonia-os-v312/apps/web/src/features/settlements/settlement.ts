/**
 * "Plata por entrar" (migración 176, plan Full): lo cobrado con posnet, QR o
 * transferencia que todavía no llegó al banco. Como las empresas grandes:
 *
 * - Cada cuenta tiene sus condiciones: en cuántos días hábiles acredita y qué
 *   porcentaje descuentan. Con eso cada día de ventas es un "lote" con fecha
 *   esperada y neto esperado (bruto × (1 − %)).
 * - Lo que confirma que entró es el resumen del banco que ya se sube en
 *   Conciliación:
 *   - Cuentas que NO son posnet (transferencias, QR que caen uno a uno): cada
 *     cobro se cruza solo con su línea del banco, así que lo pendiente es
 *     exacto (los cobros sin cruzar).
 *   - Posnet: el banco acredita por lote, por marca y con la comisión ya
 *     descontada, así que las acreditaciones se reparten entre los lotes del
 *     más viejo al más nuevo (por neto esperado).
 * - Sin resumen subido no se puede confirmar nada: se supone que entró en la
 *   fecha esperada.
 *
 * Lógica pura (sin Supabase) para poder testearla.
 */

import { isBusinessDay } from "../accounting/tax-calendar";

export interface SettleAccount {
  id: string;
  name: string;
  /** Días hábiles hasta que llega al banco (0 = en el momento). */
  days: number;
  /** Lo que descuentan (comisión + IVA + retenciones), en %. */
  feePct: number;
  /** Cuenta del banco de Conciliación donde cae la plata (null = ninguna). */
  reconId: string | null;
  /** Es posnet en esa cuenta del banco (se acredita por lote). */
  isCard: boolean;
}

export interface SaleDay {
  accountId: string;
  date: string;
  gross: number;
  /** Lo de ese día que ya se cruzó con una línea del banco (solo cuentas que no son posnet). */
  grossMatched: number;
}

export interface CardCredit {
  reconId: string;
  date: string;
  amount: number;
}

export interface ReconCoverage {
  reconId: string;
  /** Primer y último día que traen los resúmenes subidos (null = nunca se subió). */
  firstDate: string | null;
  lastDate: string | null;
}

export type LotStatus = "entro" | "por_entrar" | "atrasado";

export interface Lot {
  accountId: string;
  saleDate: string;
  expectedDate: string;
  gross: number;
  expectedNet: number;
  /** Lo que falta entrar, en bruto (lo que figura en Tesorería). */
  pendingGross: number;
  pendingNet: number;
  status: LotStatus;
  /** true si no hay resumen que lo confirme (se supone por la fecha). */
  assumed: boolean;
}

export interface AccountSettlement {
  account: SettleAccount;
  lots: Lot[];
  pendingGross: number;
  pendingNet: number;
  lateGross: number;
  /** Lo que de verdad descontaron en el período que cubre el resumen (solo posnet). */
  realFeePct: number | null;
}

/** Días que se esperan después del día previsto antes de llamarlo "atrasado". */
export const LATE_GRACE_BUSINESS_DAYS = 2;

const round2 = (n: number) => Math.round(n * 100) / 100;

function shiftDay(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** El día que llega algo que tarda `days` días hábiles (0 = el mismo día). */
export function addBusinessDays(isoDate: string, days: number): string {
  let d = isoDate;
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    d = shiftDay(d, 1);
    if (isBusinessDay(d)) left--;
  }
  return d;
}

function isLate(expectedDate: string, lastStatementDate: string): boolean {
  return addBusinessDays(expectedDate, LATE_GRACE_BUSINESS_DAYS) <= lastStatementDate;
}

export function settle(input: {
  accounts: SettleAccount[];
  sales: SaleDay[];
  cardCredits: CardCredit[];
  coverage: ReconCoverage[];
  today: string;
}): AccountSettlement[] {
  const coverageById = new Map(input.coverage.map((c) => [c.reconId, c]));
  const lotsByAccount = new Map<string, Lot[]>();

  const baseLot = (a: SettleAccount, s: SaleDay): Lot => {
    const expectedDate = addBusinessDays(s.date, a.days);
    return {
      accountId: a.id,
      saleDate: s.date,
      expectedDate,
      gross: round2(s.gross),
      expectedNet: round2(s.gross * (1 - a.feePct / 100)),
      pendingGross: 0,
      pendingNet: 0,
      status: "entro",
      assumed: false
    };
  };

  const setPending = (a: SettleAccount, lot: Lot, pendingGross: number, lastDate: string | null) => {
    lot.pendingGross = round2(Math.max(0, pendingGross));
    lot.pendingNet = round2(lot.pendingGross * (1 - a.feePct / 100));
    if (lot.pendingGross < 1) {
      lot.pendingGross = 0;
      lot.pendingNet = 0;
      lot.status = "entro";
    } else if (lastDate && isLate(lot.expectedDate, lastDate)) {
      lot.status = "atrasado";
    } else {
      lot.status = "por_entrar";
    }
  };

  const accountById = new Map(input.accounts.map((a) => [a.id, a]));
  const salesByAccount = new Map<string, SaleDay[]>();
  for (const s of input.sales) {
    if (!accountById.has(s.accountId) || s.gross <= 0) continue;
    const list = salesByAccount.get(s.accountId) ?? [];
    list.push(s);
    salesByAccount.set(s.accountId, list);
  }

  // Posnet: se juntan por cuenta del banco, porque el banco acredita todo junto.
  const cardPools = new Map<string, { account: SettleAccount; lot: Lot }[]>();

  for (const a of input.accounts) {
    const cov = a.reconId ? coverageById.get(a.reconId) : undefined;
    const confirmable = Boolean(cov?.firstDate && cov?.lastDate);
    const lots: Lot[] = [];
    for (const s of (salesByAccount.get(a.id) ?? []).sort((x, y) => x.date.localeCompare(y.date))) {
      const lot = baseLot(a, s);
      if (!confirmable) {
        // Sin resumen: se supone que entró el día previsto.
        lot.assumed = true;
        setPending(a, lot, lot.expectedDate > input.today ? lot.gross : 0, null);
      } else if (lot.expectedDate < cov!.firstDate!) {
        // Antes de lo que cubre el primer resumen: no se puede saber, se da por entrado.
        lot.assumed = true;
      } else if (a.isCard) {
        const pool = cardPools.get(a.reconId!) ?? [];
        pool.push({ account: a, lot });
        cardPools.set(a.reconId!, pool);
      } else {
        setPending(a, lot, s.gross - s.grossMatched, cov!.lastDate);
      }
      lots.push(lot);
    }
    lotsByAccount.set(a.id, lots);
  }

  for (const [reconId, pool] of cardPools) {
    const cov = coverageById.get(reconId)!;
    let credit = input.cardCredits.filter((c) => c.reconId === reconId && c.date >= cov.firstDate!).reduce((s, c) => s + c.amount, 0);
    pool.sort((x, y) => x.lot.expectedDate.localeCompare(y.lot.expectedDate) || x.lot.saleDate.localeCompare(y.lot.saleDate));
    for (const { account, lot } of pool) {
      const used = Math.min(credit, lot.expectedNet);
      credit -= used;
      const uncoveredShare = lot.expectedNet > 0 ? (lot.expectedNet - used) / lot.expectedNet : 0;
      setPending(account, lot, lot.gross * uncoveredShare, cov.lastDate);
    }
  }

  return input.accounts.map((a) => {
    const lots = lotsByAccount.get(a.id) ?? [];
    const pending = lots.filter((l) => l.status !== "entro");
    return {
      account: a,
      lots,
      pendingGross: round2(pending.reduce((s, l) => s + l.pendingGross, 0)),
      pendingNet: round2(pending.reduce((s, l) => s + l.pendingNet, 0)),
      lateGross: round2(pending.filter((l) => l.status === "atrasado").reduce((s, l) => s + l.pendingGross, 0)),
      realFeePct: a.isCard && a.reconId ? measuredCardFee(a.reconId, input) : null
    };
  });
}

/**
 * Lo que descontaron de verdad en lo que cubre el resumen: lo que tenía que
 * entrar en esas fechas (bruto) contra lo que entró. Sin al menos 2 semanas de
 * resumen no se calcula (los bordes pesan demasiado).
 */
function measuredCardFee(reconId: string, input: Parameters<typeof settle>[0]): number | null {
  const cov = input.coverage.find((c) => c.reconId === reconId);
  if (!cov?.firstDate || !cov.lastDate || shiftDay(cov.firstDate, 14) > cov.lastDate) return null;
  const cards = input.accounts.filter((a) => a.isCard && a.reconId === reconId);
  const cardIds = new Set(cards.map((a) => a.id));
  const daysById = new Map(cards.map((a) => [a.id, a.days]));
  let expected = 0;
  for (const s of input.sales) {
    if (!cardIds.has(s.accountId)) continue;
    const e = addBusinessDays(s.date, daysById.get(s.accountId) ?? 0);
    if (e >= cov.firstDate && e <= cov.lastDate) expected += s.gross;
  }
  const credited = input.cardCredits.filter((c) => c.reconId === reconId && c.date >= cov.firstDate! && c.date <= cov.lastDate!).reduce((s, c) => s + c.amount, 0);
  if (expected <= 0 || credited <= 0) return null;
  return Math.round((1 - credited / expected) * 1000) / 10;
}

/** ¿Conviene avisar que el % cargado no es el real? (más de medio punto de diferencia). */
export function feeLooksWrong(s: AccountSettlement): boolean {
  return s.realFeePct !== null && s.realFeePct >= 0 && s.realFeePct < 30 && Math.abs(s.realFeePct - s.account.feePct) > 0.5;
}

/** Lo que va a entrar por día (neto), de hoy en adelante. Lo previsto para antes de hoy se muestra hoy. */
export function upcomingByDay(settlements: AccountSettlement[], today: string): { date: string; net: number; gross: number }[] {
  const map = new Map<string, { net: number; gross: number }>();
  for (const s of settlements) {
    for (const l of s.lots) {
      if (l.status !== "por_entrar") continue;
      const date = l.expectedDate < today ? today : l.expectedDate;
      const r = map.get(date) ?? { net: 0, gross: 0 };
      r.net += l.pendingNet;
      r.gross += l.pendingGross;
      map.set(date, r);
    }
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, r]) => ({ date, net: round2(r.net), gross: round2(r.gross) }));
}

/* ------------------------- comisiones de posnet por mes ------------------------- */

export interface CardFeeMonth {
  reconId: string;
  /** "2026-10" */
  month: string;
  /** Lo vendido con posnet que tenía que entrar ese mes (bruto). */
  expected: number;
  /** Lo que el banco acreditó ese mes. */
  credited: number;
  fee: number;
  feePct: number;
}

function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Meses completos que el resumen cubre de punta a punta y ya terminaron, con
 * lo que descontaron las tarjetas: lo que tenía que entrar ese mes − lo que
 * entró. Es lo que se anota en Tesorería como gasto (una vez por mes).
 */
export function cardFeeMonths(input: {
  accounts: SettleAccount[];
  sales: SaleDay[];
  cardCredits: CardCredit[];
  coverage: ReconCoverage[];
  today: string;
}): CardFeeMonth[] {
  const out: CardFeeMonth[] = [];
  for (const cov of input.coverage) {
    if (!cov.firstDate || !cov.lastDate) continue;
    const cards = input.accounts.filter((a) => a.isCard && a.reconId === cov.reconId);
    if (cards.length === 0) continue;
    const daysById = new Map(cards.map((a) => [a.id, a.days]));
    const expected = new Map<string, number>();
    for (const s of input.sales) {
      if (!daysById.has(s.accountId)) continue;
      const month = addBusinessDays(s.date, daysById.get(s.accountId)!).slice(0, 7);
      expected.set(month, (expected.get(month) ?? 0) + s.gross);
    }
    const credited = new Map<string, number>();
    for (const c of input.cardCredits) {
      if (c.reconId !== cov.reconId) continue;
      credited.set(c.date.slice(0, 7), (credited.get(c.date.slice(0, 7)) ?? 0) + c.amount);
    }
    for (const [month, exp] of expected) {
      const start = `${month}-01`;
      const end = monthEnd(month);
      if (start < cov.firstDate || end > cov.lastDate || end >= input.today) continue;
      const cred = credited.get(month) ?? 0;
      const fee = round2(exp - cred);
      if (exp <= 0 || cred <= 0 || fee <= 0) continue;
      out.push({ reconId: cov.reconId, month, expected: round2(exp), credited: round2(cred), fee, feePct: Math.round((fee / exp) * 1000) / 10 });
    }
  }
  return out.sort((a, b) => a.month.localeCompare(b.month));
}
