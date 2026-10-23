// Próximos vencimientos (migración 156). Lógica pura.
// Fuente de las fechas, en este orden:
//   1. El calendario oficial de ARCA cargado en official_due_dates (por mes,
//      obligación y terminación de CUIT).
//   2. Si ese mes todavía no está cargado (ARCA lo publica mes a mes): el mismo
//      día del último mes cargado, corrido al siguiente día hábil, marcado
//      como "estimada".
//   3. Los recordatorios propios del negocio (tax_reminders) y el día de
//      Ingresos Brutos que cargó en Contable.

export type Obligation = "iva" | "monotributo" | "empleadores" | "autonomos" | "ganancias_anticipo";

export const OBLIGATION_LABELS: Record<Obligation, string> = {
  iva: "IVA y Libro IVA Digital",
  monotributo: "Monotributo",
  empleadores: "Cargas sociales de empleados (F. 931)",
  autonomos: "Autónomos",
  ganancias_anticipo: "Anticipo de Ganancias"
};

export interface OfficialDue {
  /** AAAA-MM-01 */
  month: string;
  obligation: Obligation;
  /** "0-1", "0-1-2-3" o "todos" */
  digits: string;
  /** AAAA-MM-DD */
  dueDate: string;
}

export interface TaxReminder {
  id: string;
  title: string;
  dayOfMonth: number;
  active: boolean;
}

export interface DueItem {
  date: string;
  title: string;
  kind: "oficial" | "estimada" | "propio";
  obligation?: Obligation;
  daysLeft: number;
}

/** Feriados nacionales (inamovibles y trasladables ya fijados) de 2026 y 2027. */
const HOLIDAYS = new Set([
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-03-23", "2026-03-24", "2026-04-02", "2026-04-03", "2026-05-01", "2026-05-25",
  "2026-06-15", "2026-06-20", "2026-07-09", "2026-07-10", "2026-08-17", "2026-10-12", "2026-11-23", "2026-12-07", "2026-12-08", "2026-12-25",
  "2027-01-01", "2027-02-08", "2027-02-09", "2027-03-24", "2027-03-25", "2027-03-26", "2027-04-02", "2027-05-01", "2027-05-25",
  "2027-06-20", "2027-07-09", "2027-08-16", "2027-10-11", "2027-11-22", "2027-12-08", "2027-12-25"
]);

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateOf(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`);
}

export function isBusinessDay(isoDate: string): boolean {
  const day = dateOf(isoDate).getUTCDay();
  return day !== 0 && day !== 6 && !HOLIDAYS.has(isoDate);
}

export function nextBusinessDay(isoDate: string): string {
  let d = dateOf(isoDate);
  while (!isBusinessDay(iso(d))) d = new Date(d.getTime() + 86400_000);
  return iso(d);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Día del mes en un mes dado, sin pasarse (el 31 en noviembre es el 30). */
function dayIn(month: string, day: number): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, daysInMonth(y, m))).padStart(2, "0")}`;
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return iso(d).slice(0, 8) + "01";
}

function covers(digits: string, lastDigit: number | null): boolean {
  if (digits === "todos") return true;
  if (lastDigit === null) return false;
  return digits.split("-").map(Number).includes(lastDigit);
}

export function defaultObligations(taxCondition: string | null): Obligation[] {
  if (taxCondition === "monotributo") return ["monotributo"];
  if (taxCondition === "responsable_inscripto") return ["iva"];
  return [];
}

export function upcomingDues(input: {
  today: string;
  cuit: string | null;
  taxCondition: string | null;
  obligations: Obligation[] | null;
  official: OfficialDue[];
  reminders: TaxReminder[];
  iibbDueDay: number | null;
  horizonDays?: number;
}): { items: DueItem[]; missingCuit: boolean } {
  const horizon = input.horizonDays ?? 45;
  const digits = (input.cuit ?? "").replace(/\D/g, "");
  const lastDigit = digits.length === 11 ? Number(digits[10]) : null;
  const obligations = input.obligations ?? defaultObligations(input.taxCondition);
  const todayDate = dateOf(input.today);
  const limit = iso(new Date(todayDate.getTime() + horizon * 86400_000));
  const items: DueItem[] = [];
  let missingCuit = false;
  const thisMonth = input.today.slice(0, 8) + "01";

  for (let k = 0; k <= Math.ceil(horizon / 28); k++) {
    const month = addMonths(thisMonth, k);
    for (const obligation of obligations) {
      const rows = input.official.filter((r) => r.obligation === obligation);
      const exact = rows.find((r) => r.month === month && covers(r.digits, lastDigit));
      if (exact) {
        items.push({ date: exact.dueDate, title: OBLIGATION_LABELS[obligation], kind: "oficial", obligation, daysLeft: 0 });
        continue;
      }
      const forDigit = rows.filter((r) => covers(r.digits, lastDigit)).sort((a, b) => b.month.localeCompare(a.month))[0];
      if (!forDigit) {
        if (rows.some((r) => r.digits !== "todos")) missingCuit = true;
        continue;
      }
      const day = Number(forDigit.dueDate.slice(8, 10));
      items.push({ date: nextBusinessDay(dayIn(month, day)), title: OBLIGATION_LABELS[obligation], kind: "estimada", obligation, daysLeft: 0 });
    }
    // Como los vencimientos de verdad: si cae sábado, domingo o feriado, pasa al día hábil siguiente.
    for (const r of input.reminders) {
      if (r.active) items.push({ date: nextBusinessDay(dayIn(month, r.dayOfMonth)), title: r.title, kind: "propio", daysLeft: 0 });
    }
    if (input.iibbDueDay) items.push({ date: nextBusinessDay(dayIn(month, input.iibbDueDay)), title: "Ingresos Brutos", kind: "propio", daysLeft: 0 });
  }

  const result = items
    .filter((i) => i.date >= input.today && i.date <= limit)
    .map((i) => ({ ...i, daysLeft: Math.round((dateOf(i.date).getTime() - todayDate.getTime()) / 86400_000) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  return { items: result, missingCuit };
}

/** "lunes 19/10" */
export function dueDateLabel(isoDate: string): string {
  const names = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const d = dateOf(isoDate);
  return `${names[d.getUTCDay()]} ${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}`;
}

export function daysLeftLabel(days: number): string {
  if (days === 0) return "hoy";
  if (days === 1) return "mañana";
  return `en ${days} días`;
}
