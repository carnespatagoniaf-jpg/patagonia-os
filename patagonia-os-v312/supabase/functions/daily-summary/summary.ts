// Resumen diario del panel de plataforma para WhatsApp (migración 209). Lógica pura, sin Deno ni Supabase:
// la prueban las pruebas de la web (apps/web/src/features/admin/daily-summary-server.test.ts), que también
// controlan que el semáforo dé lo mismo que el del panel (client-health.ts).
//
// La API de WhatsApp solo deja mandar mensajes que uno no contesta con una PLANTILLA aprobada por Meta, y cada
// variable de la plantilla tiene que ser una sola línea. Plantilla `resumen_diario` (Español Argentina, Utilidad):
//
//   Resumen de {{1}}
//   Cobrado en el mes: {{2}}
//   Deben el abono: {{3}}
//   Vencen esta semana: {{4}}
//   Pueden irse: {{5}}
//   Para mirar: {{6}}
//   Más detalle en el panel.

const DAY = 86_400_000;
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
/** Lo que paga por mes un cliente sin pagos anotados (dueño, 03/11/2026: $39.000 por local). */
const DEFAULT_FEE = 39000;
/** Mismo tope que el panel (planPrice en AdminCreateClient): un pago mayor es de varios meses. */
const MAX_MONTHLY_FEE = 69000;

export interface UsageRow {
  product_count: number;
  sale_count: number;
  sales_last_7d: number;
  first_sale_at: string | null;
  last_sale_at: string | null;
  last_sign_in_at: string | null;
}

export interface CompanyRow {
  id: string;
  name: string;
  created_at: string;
  paid_until: string | null;
  trial_ends_at: string | null;
  last_payment_amount: number | null;
  /** Suscripción de Mercado Pago autorizada: se cobra sola. */
  mp_ok: boolean;
  usage: UsageRow;
}

/** Lo que devuelve platform_daily_summary_data() (migración 209). */
export interface SummaryData {
  today: string;
  companies: CompanyRow[];
  collected_month: number;
  collected_yesterday: number;
}

export type Level = "ok" | "warn" | "risk";

function daysBetween(fromIso: string, toIso: string) {
  return Math.round((Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / DAY);
}

function daysSince(iso: string | null, now: number): number | null {
  return iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY)) : null;
}

export function owes(c: CompanyRow, today: string, now: number): boolean {
  if (c.mp_ok) return false;
  if (c.paid_until) return daysBetween(today, c.paid_until) < 0;
  return c.trial_ends_at !== null && new Date(c.trial_ends_at).getTime() <= now;
}

export function monthsOwed(c: CompanyRow, today: string): number {
  if (!c.paid_until) return 0;
  const days = daysBetween(today, c.paid_until);
  return days >= 0 ? 0 : Math.max(1, Math.ceil(-days / 30));
}

export function monthlyFee(c: CompanyRow): number {
  const last = c.last_payment_amount;
  return last && last > 0 && last <= MAX_MONTHLY_FEE ? last : DEFAULT_FEE;
}

/** El mismo semáforo que client-health.ts del panel (las pruebas controlan que coincidan). */
export function health(c: CompanyRow, today: string, now: number): { level: Level; reasons: string[] } {
  const risk: string[] = [];
  const warn: string[] = [];
  const u = c.usage;
  const age = daysSince(c.created_at, now) ?? 0;
  const lastSale = daysSince(u.last_sale_at, now);
  if (u.product_count === 0) (age >= 3 ? risk : warn).push("No cargó productos");
  else if (lastSale === null) (age >= 7 ? risk : warn).push("Cargó productos pero nunca vendió");
  else if (lastSale >= 14) risk.push(`No vende hace ${lastSale} días`);
  else if (lastSale >= 7) warn.push(`No vende hace ${lastSale} días`);

  const since = daysSince(u.first_sale_at, now);
  if (since !== null && since >= 14 && lastSale !== null && lastSale < 7) {
    const avg = (u.sale_count - u.sales_last_7d) / ((since - 7) / 7);
    if (avg >= 20) {
      const text = `Vende menos: ${u.sales_last_7d} ventas esta semana, antes unas ${Math.round(avg)}`;
      if (u.sales_last_7d < avg * 0.25) risk.push(text);
      else if (u.sales_last_7d < avg * 0.5) warn.push(text);
    }
  }
  const signIn = daysSince(u.last_sign_in_at, now);
  if (signIn !== null && signIn >= 21) warn.push(`Nadie entra al sistema hace ${signIn} días`);
  if (owes(c, today, now)) (risk.length > 0 ? risk : warn).push("Debe el abono");
  return { level: risk.length > 0 ? "risk" : warn.length > 0 ? "warn" : "ok", reasons: [...risk, ...warn] };
}

function pesos(value: number) {
  return `$${Math.round(value).toLocaleString("es-AR")}`;
}

function names(list: string[], max: number) {
  if (list.length === 0) return "nadie";
  return list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} y ${list.length - max} más`;
}

/** WhatsApp rechaza variables con saltos de línea, tabs o más de 4 espacios seguidos. */
function oneLine(text: string, max = 900) {
  const clean = text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Las 6 variables de la plantilla `resumen_diario`. */
export function templateParams(brandName: string, data: SummaryData, now: number = Date.now()): string[] {
  const today = data.today;
  const date = new Date(`${today}T12:00:00Z`);
  const header = `${brandName} · ${WEEKDAYS[date.getUTCDay()]} ${today.slice(8, 10)}/${today.slice(5, 7)}`;

  const collected = `${pesos(data.collected_month)}${data.collected_yesterday > 0 ? ` (ayer ${pesos(data.collected_yesterday)})` : ""}`;

  const debtors = data.companies.filter((c) => monthsOwed(c, today) > 0 && !c.mp_ok);
  const debt = debtors.reduce((sum, c) => sum + monthsOwed(c, today) * monthlyFee(c), 0);
  const owesText = debtors.length === 0 ? "nadie" : `${debtors.length} ${debtors.length === 1 ? "cliente" : "clientes"}, ${pesos(debt)}`;

  const dueSoon = data.companies
    .filter((c) => !c.mp_ok && c.paid_until)
    .map((c) => ({ c, days: daysBetween(today, c.paid_until!) }))
    .filter((x) => x.days >= 0 && x.days <= 7)
    .sort((a, b) => a.days - b.days)
    .map(({ c, days }) => `${c.name} (${days === 0 ? "hoy" : days === 1 ? "mañana" : `en ${days} días`})`);

  const states = data.companies.map((c) => ({ c, h: health(c, today, now) }));
  const risk = states.filter((s) => s.h.level === "risk").map((s) => `${s.c.name} (${s.h.reasons[0].charAt(0).toLowerCase()}${s.h.reasons[0].slice(1)})`);
  const warn = states.filter((s) => s.h.level === "warn").map((s) => s.c.name);

  return [header, collected, owesText, names(dueSoon, 4), names(risk, 4), names(warn, 5)].map((p) => oneLine(p));
}

/** El mismo mensaje en texto, para mostrarlo o probarlo sin mandarlo. */
export function previewText(params: string[]): string {
  const [header, collected, owesText, due, risk, warn] = params;
  return [
    `Resumen de ${header}`,
    `Cobrado en el mes: ${collected}`,
    `Deben el abono: ${owesText}`,
    `Vencen esta semana: ${due}`,
    `Pueden irse: ${risk}`,
    `Para mirar: ${warn}`,
    "Más detalle en el panel."
  ].join("\n");
}

/** Número argentino a formato internacional para la API (549 + característica + número, sin 15). */
export function toWhatsAppNumber(phone: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (!digits.startsWith("54")) {
    if (digits.length === 12) digits = digits.replace(/^(\d{2,4})15(\d{6,8})$/, "$1$2");
    digits = `549${digits}`;
  } else if (!digits.startsWith("549")) {
    digits = `549${digits.slice(2)}`;
  }
  return digits.length >= 12 && digits.length <= 13 ? digits : null;
}

/** Hora argentina (0-23) de un momento. */
export function argentinaHour(now: number): number {
  return new Date(now - 3 * 3_600_000).getUTCHours();
}
