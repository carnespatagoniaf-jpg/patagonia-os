/** Estado de pago del abono de cada cliente en el panel de plataforma
 * (migración 110). Lógica pura, sin lib/supabase, para poder testearla. */

export type BillingStatus = "overdue" | "trial_expired" | "due_soon" | "trial" | "none" | "paid";
export type BillingFilter = "all" | "paid" | "owes" | "trial" | "none";

export interface BillingInfo {
  name: string;
  clientNumber?: number;
  ownerFullName?: string | null;
  ownerEmail?: string | null;
  contactPhone?: string | null;
  city?: string | null;
  province?: string | null;
  /** YYYY-MM-DD */
  paidUntil: string | null;
  trialEndsAt: string | null;
}

/** Días antes del vencimiento en que "Pagó" pasa a "Vence pronto". */
export const DUE_SOON_DAYS = 5;

function daysBetween(fromIso: string, toIso: string) {
  return Math.round((Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** Días hasta el vencimiento del abono (negativo = vencido hace N días). null si nunca pagó. */
export function paidDaysLeft(info: BillingInfo, todayIso: string): number | null {
  return info.paidUntil ? daysBetween(todayIso, info.paidUntil) : null;
}

export function billingStatus(info: BillingInfo, todayIso: string, now: number = Date.now()): BillingStatus {
  const days = paidDaysLeft(info, todayIso);
  if (days !== null) {
    if (days < 0) return "overdue";
    return days <= DUE_SOON_DAYS ? "due_soon" : "paid";
  }
  if (info.trialEndsAt) return new Date(info.trialEndsAt).getTime() <= now ? "trial_expired" : "trial";
  return "none";
}

export function matchesBillingFilter(status: BillingStatus, filter: BillingFilter) {
  switch (filter) {
    case "all": return true;
    case "paid": return status === "paid" || status === "due_soon";
    case "owes": return status === "overdue" || status === "trial_expired";
    case "trial": return status === "trial";
    case "none": return status === "none";
  }
}

/** Orden "por estado de pago": primero a quién hay que cobrarle. */
export const STATUS_ORDER: Record<BillingStatus, number> = { overdue: 0, trial_expired: 1, due_soon: 2, trial: 3, none: 4, paid: 5 };

function normalize(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Busca por número ("7", "#7", "Nº 7"), negocio, dueño, mail, teléfono, ciudad o provincia. */
export function matchesCompanySearch(info: BillingInfo, query: string) {
  const q = normalize(query);
  if (!q) return true;
  const asNumber = q.replace(/^(#|n[º°o]?\.?\s*)/, "");
  if (/^\d+$/.test(asNumber) && info.clientNumber !== undefined && String(info.clientNumber) === asNumber) return true;
  if ([info.name, info.ownerFullName, info.ownerEmail, info.city, info.province].some((v) => v && normalize(v).includes(q))) return true;
  const digits = q.replace(/\D/g, "");
  return digits.length >= 3 && !!info.contactPhone && info.contactPhone.replace(/\D/g, "").includes(digits);
}

export function sortByBilling<T extends BillingInfo>(list: T[], todayIso: string, now: number = Date.now()): T[] {
  return list
    .map((c) => ({ c, s: billingStatus(c, todayIso, now) }))
    .sort((a, b) => STATUS_ORDER[a.s] - STATUS_ORDER[b.s] || (a.c.paidUntil ?? "").localeCompare(b.c.paidUntil ?? "") || (a.c.clientNumber ?? 0) - (b.c.clientNumber ?? 0))
    .map(({ c }) => c);
}

export function formatDayMonth(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** Texto corto del estado para la etiqueta de la tarjeta. */
export function billingLabel(info: BillingInfo, todayIso: string, now: number = Date.now()): string {
  const status = billingStatus(info, todayIso, now);
  const days = paidDaysLeft(info, todayIso);
  switch (status) {
    case "paid": return `Pagó hasta ${formatDayMonth(info.paidUntil!)}`;
    case "due_soon": return days === 0 ? "Vence hoy" : days === 1 ? "Vence mañana" : `Vence en ${days} días`;
    case "overdue": return `Debe desde ${formatDayMonth(info.paidUntil!)}`;
    case "trial": {
      const left = Math.ceil((new Date(info.trialEndsAt!).getTime() - now) / 86_400_000);
      return left === 1 ? "Prueba: vence mañana" : `Prueba: ${left} días`;
    }
    case "trial_expired": return "Prueba vencida, sin pago";
    case "none": return "Sin pagos registrados";
  }
}
