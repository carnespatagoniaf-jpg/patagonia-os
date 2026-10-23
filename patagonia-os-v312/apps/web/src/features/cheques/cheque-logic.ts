/** Cheques (migración 150): estados, textos y avisos. Lógica pura, sin
 * lib/supabase, para poder testearla. Fechas en AAAA-MM-DD (hora argentina). */

export type ChequeKind = "received" | "issued";
export type ChequeStatus = "in_portfolio" | "deposited" | "endorsed" | "rejected" | "pending" | "debited";

export interface Cheque {
  id: string;
  kind: ChequeKind;
  echeq: boolean;
  number: string;
  bank: string | null;
  drawerName: string | null;
  drawerCuit: string | null;
  amount: number;
  payDate: string;
  status: ChequeStatus;
  customerName: string | null;
  supplierName: string | null;
  bankAccountName: string | null;
  stepDate: string | null;
  notes: string | null;
  createdAt: string;
}

export const STATUS_LABELS: Record<ChequeStatus, string> = {
  in_portfolio: "En cartera",
  deposited: "Depositado",
  endorsed: "Endosado",
  rejected: "Rechazado",
  pending: "Por debitar",
  debited: "Debitado"
};

/** Lo que todavía hay que hacer con el cheque. */
export function isOpen(c: Pick<Cheque, "status">): boolean {
  return c.status === "in_portfolio" || c.status === "pending";
}

/** Un cheque se puede depositar hasta 30 días después de su fecha de pago
 * (Ley de Cheques 24.452, art. 25). */
export const PRESENTATION_DAYS = 30;

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / 86400000);
}

export function lastDepositDay(c: Pick<Cheque, "payDate">): string {
  return addDays(c.payDate, PRESENTATION_DAYS);
}

export type DueTone = "late" | "soon" | "ok";

/** Cómo viene la fecha de un cheque abierto, para mostrarlo en la lista. */
export function dueInfo(c: Pick<Cheque, "kind" | "status" | "payDate">, today: string): { text: string; tone: DueTone } | null {
  if (!isOpen(c)) return null;
  const days = daysBetween(today, c.payDate);
  if (c.kind === "received") {
    if (days > 0) return { text: days === 1 ? "se puede depositar mañana" : `se puede depositar en ${days} días`, tone: days <= 7 ? "soon" : "ok" };
    const left = daysBetween(today, lastDepositDay(c));
    if (left < 0) return { text: "venció el plazo para depositarlo", tone: "late" };
    return { text: left === 0 ? "depositalo hoy: es el último día" : `ya se puede depositar (quedan ${left} días)`, tone: left <= 5 ? "late" : "soon" };
  }
  if (days < 0) return { text: `se tenía que debitar hace ${-days} día${days === -1 ? "" : "s"}`, tone: "late" };
  if (days === 0) return { text: "se debita hoy", tone: "late" };
  return { text: days === 1 ? "se debita mañana" : `se debita en ${days} días`, tone: days <= 7 ? "soon" : "ok" };
}

export interface ChequeAlerts {
  toDeposit: { count: number; total: number };
  expiring: { count: number; total: number };
  toDebit: { count: number; total: number };
}

/**
 * Avisos de Inicio:
 * - toDeposit: recibidos en cartera que ya se pueden depositar o se pueden en los próximos 7 días.
 * - expiring: de esos, los que les quedan 5 días o menos (o ya vencieron) para depositar.
 * - toDebit: propios por debitar en los próximos 7 días (o atrasados).
 */
export function chequeAlerts(cheques: Cheque[], today: string): ChequeAlerts {
  const sum = (list: Cheque[]) => ({ count: list.length, total: list.reduce((s, c) => s + c.amount, 0) });
  const horizon = addDays(today, 7);
  const portfolio = cheques.filter((c) => c.kind === "received" && c.status === "in_portfolio");
  return {
    toDeposit: sum(portfolio.filter((c) => c.payDate <= horizon)),
    expiring: sum(portfolio.filter((c) => c.payDate <= today && daysBetween(today, lastDepositDay(c)) <= 5)),
    toDebit: sum(cheques.filter((c) => c.kind === "issued" && c.status === "pending" && c.payDate <= horizon))
  };
}

/** Abiertos primero (por fecha de pago), después el historial (lo último movido arriba). */
export function sortCheques(list: Cheque[]): Cheque[] {
  return [...list].sort((a, b) => {
    const oa = isOpen(a) ? 0 : 1;
    const ob = isOpen(b) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    if (oa === 0) return a.payDate.localeCompare(b.payDate) || a.createdAt.localeCompare(b.createdAt);
    return (b.stepDate ?? b.createdAt).localeCompare(a.stepDate ?? a.createdAt);
  });
}

export function openTotal(list: Cheque[], kind: ChequeKind): number {
  return list.filter((c) => c.kind === kind && isOpen(c)).reduce((s, c) => s + c.amount, 0);
}

/** Texto del botón "Deshacer" según el estado. */
export function undoLabel(c: Pick<Cheque, "status">): string {
  switch (c.status) {
    case "deposited": return "Deshacer depósito";
    case "endorsed": return "Deshacer endoso";
    case "rejected": return "Deshacer rechazo";
    case "debited": return "Deshacer débito";
    default: return "Borrar cheque";
  }
}

export function chequeTitle(c: Pick<Cheque, "echeq" | "number" | "bank">): string {
  return `${c.echeq ? "eCheq" : "Cheque"} N.º ${c.number}${c.bank ? ` · ${c.bank}` : ""}`;
}

export function formatDay(iso: string | null): string {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

export function cleanCuit(text: string): string {
  return text.replace(/\D/g, "");
}

/** Valida los datos comunes al cargar un cheque. Devuelve el error o null. */
export function validateChequeInput(input: { number: string; amount: number; payDate: string; cuit?: string }): string | null {
  if (!input.number.trim()) return "Poné el número del cheque.";
  if (!Number.isFinite(input.amount) || input.amount <= 0) return "Poné el monto del cheque.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.payDate)) return "Poné la fecha de cobro del cheque.";
  const cuit = cleanCuit(input.cuit ?? "");
  if (cuit && cuit.length !== 11) return "El CUIT tiene que tener 11 números.";
  return null;
}
