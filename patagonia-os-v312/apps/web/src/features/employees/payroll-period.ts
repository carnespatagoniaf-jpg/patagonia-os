import type { SalaryPeriod } from "@patagonia/domain";

/**
 * Vales y premios/descuentos pendientes que quedaron ANTES del período elegido
 * en Liquidación (ej. se liquida la semana y quedaron vales de la anterior sin
 * liquidar). La base no deja liquidar un período que se superpone con otra
 * liquidación (close_payroll_liquidation), así que solo se pueden sumar
 * corriendo el "desde" hasta el día siguiente a la última liquidación.
 */
export interface PendingItem {
  date: string;
  kind: "voucher" | "adjustment";
  /** Con signo: el vale resta, el premio suma, el descuento resta. */
  amount: number;
}

export interface LiquidatedRange {
  periodStart: string;
  periodEnd: string;
}

export interface EarlierPending {
  /** Los que se pueden sumar moviendo el "desde" a includeFrom. */
  includable: PendingItem[];
  includeFrom: string | null;
  /** Los que caen en días ya liquidados (o antes de la última liquidación): para descontarlos hay que rehacer esa liquidación. */
  stuck: PendingItem[];
}

export function earlierPending(items: PendingItem[], periodStart: string, liquidations: LiquidatedRange[]): EarlierPending {
  const lastEndBefore = liquidations
    .filter((l) => l.periodEnd < periodStart)
    .reduce<string | null>((max, l) => (max === null || l.periodEnd > max ? l.periodEnd : max), null);
  const before = items.filter((i) => i.date < periodStart);
  const includable = before.filter((i) => lastEndBefore === null || i.date > lastEndBefore);
  const stuck = before.filter((i) => !includable.includes(i));
  const includeFrom = includable.reduce<string | null>((min, i) => (min === null || i.date < min ? i.date : min), null);
  return { includable, includeFrom, stuck };
}

/** "2026-10-31" → "31/10". */
export function shortDate(iso: string) {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

/** Días entre dos fechas ISO, contando las dos puntas. */
export function daysBetweenInclusive(start: string, end: string) {
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

const SALARY_PERIOD_DIVISOR: Record<Exclude<SalaryPeriod, "hourly">, number> = { daily: 1, weekly: 7, biweekly: 14, monthly: 30 };

/**
 * Sueldo del período, igual que close_payroll_liquidation: (sueldo + premio fijo) × días ÷ divisor, o por hora
 * (migración 212) (valor de la hora + premio fijo) × horas trabajadas. El servidor redondea a centavos; acá a pesos
 * enteros como siempre mostró la pantalla.
 */
export function periodBaseSalary(
  employee: { baseSalary: number; recurringBonusAmount: number; salaryPeriod: SalaryPeriod },
  days: number,
  hours: number
) {
  const rate = employee.baseSalary + employee.recurringBonusAmount;
  if (employee.salaryPeriod === "hourly") return Math.round(rate * (Number.isFinite(hours) && hours > 0 ? hours : 0));
  return Math.round((rate * days) / SALARY_PERIOD_DIVISOR[employee.salaryPeriod]);
}
