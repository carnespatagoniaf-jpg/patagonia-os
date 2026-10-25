/**
 * Finanzas de Patagonia OS como empresa (panel de administración, migración 158). Lógica pura, sin Supabase.
 * Los montos de cada cuenta están en su moneda (ARS o USD): nunca se suman pesos con dólares.
 */

export type Currency = "ARS" | "USD";
export type FinKind = "ingreso" | "gasto" | "aporte" | "retiro" | "sueldo" | "transferencia" | "ajuste";

export interface FinAccount {
  id: string;
  name: string;
  currency: Currency;
  openingBalance: number;
  receivesPayments: boolean;
  active: boolean;
  balance: number;
}

export interface FinPartner {
  id: string;
  name: string;
  sharePct: number;
}

export interface FinMovement {
  id: string;
  date: string;
  accountId: string;
  kind: FinKind;
  direction: "in" | "out";
  amount: number;
  category: string | null;
  description: string | null;
  partnerId: string | null;
  fromInvestment: boolean;
  fromPayment: boolean;
  transferId: string | null;
  recurring: boolean;
}

export interface FinRecurring {
  id: string;
  name: string;
  category: string;
  amount: number;
  accountId: string;
  dayOfMonth: number;
  fromInvestment: boolean;
  active: boolean;
}

export interface FinOverview {
  accounts: FinAccount[];
  partners: FinPartner[];
  recurring: FinRecurring[];
  movements: FinMovement[];
  investment: { currency: Currency; partnerId: string; contributed: number | null; withdrawn: number | null; salaries: number | null }[];
  investmentSpent: { currency: Currency; amount: number }[];
  monthly: { month: string; currency: Currency; income: number; expenses: number }[];
}

export const KIND_LABELS: Record<FinKind, string> = {
  ingreso: "Ingreso",
  gasto: "Gasto",
  aporte: "Aporte de socio",
  retiro: "Retiro de socio",
  sueldo: "Sueldo",
  transferencia: "Transferencia",
  ajuste: "Ajuste"
};

/** Categorías sugeridas para los gastos (se puede escribir otra). */
export const EXPENSE_CATEGORIES = [
  "Publicidad",
  "Servidores",
  "Inteligencia artificial",
  "Dominio y mails",
  "Computadoras y equipos",
  "Comisiones de cobro",
  "Viajes e instalaciones",
  "Contador e impuestos",
  "Sueldos y honorarios",
  "Otros"
];

export interface CurrencySummary {
  currency: Currency;
  income: number;
  expenses: number;
  salaries: number;
  result: number;
  byCategory: { category: string; amount: number }[];
}

/**
 * Resultado del mes por moneda: ingresos − gastos − sueldos. Aportes, retiros, transferencias y ajustes no son
 * resultado (es plata que entra o sale de los socios, o que cambia de cuenta).
 */
export function monthSummary(movements: FinMovement[], accounts: FinAccount[]): CurrencySummary[] {
  const currencyOf = new Map(accounts.map((a) => [a.id, a.currency]));
  const out = new Map<Currency, CurrencySummary>();
  for (const m of movements) {
    const currency = currencyOf.get(m.accountId);
    if (!currency || !["ingreso", "gasto", "sueldo"].includes(m.kind)) continue;
    const s = out.get(currency) ?? { currency, income: 0, expenses: 0, salaries: 0, result: 0, byCategory: [] };
    if (m.kind === "ingreso") s.income += m.amount;
    if (m.kind === "sueldo") s.salaries += m.amount;
    if (m.kind === "gasto") {
      s.expenses += m.amount;
      const category = m.category ?? "Otros";
      const row = s.byCategory.find((c) => c.category === category);
      if (row) row.amount += m.amount;
      else s.byCategory.push({ category, amount: m.amount });
    }
    out.set(currency, s);
  }
  return [...out.values()]
    .map((s) => ({ ...s, result: round2(s.income - s.expenses - s.salaries), byCategory: s.byCategory.sort((a, b) => b.amount - a.amount) }))
    .sort((a, b) => (a.currency === "ARS" ? -1 : b.currency === "ARS" ? 1 : 0));
}

/** Lo que le toca a cada socio de un resultado positivo, según su porcentaje (0 si hubo pérdida). */
export function partnerSplit(result: number, partners: FinPartner[]): { partner: FinPartner; amount: number }[] {
  return partners.map((partner) => ({ partner, amount: result > 0 ? round2((result * partner.sharePct) / 100) : 0 }));
}

/** Inversión por moneda: lo aportado por los socios, lo que se pagó con esa plata y lo que queda. */
export function investmentStatus(overview: Pick<FinOverview, "investment" | "investmentSpent">): { currency: Currency; contributed: number; spent: number; left: number }[] {
  const byCurrency = new Map<Currency, { contributed: number; spent: number }>();
  for (const row of overview.investment) {
    const c = byCurrency.get(row.currency) ?? { contributed: 0, spent: 0 };
    c.contributed += Number(row.contributed ?? 0);
    byCurrency.set(row.currency, c);
  }
  for (const row of overview.investmentSpent) {
    const c = byCurrency.get(row.currency) ?? { contributed: 0, spent: 0 };
    c.spent += Number(row.amount ?? 0);
    byCurrency.set(row.currency, c);
  }
  return [...byCurrency.entries()]
    .filter(([, v]) => v.contributed > 0 || v.spent > 0)
    .map(([currency, v]) => ({ currency, contributed: round2(v.contributed), spent: round2(v.spent), left: round2(v.contributed - v.spent) }));
}

export function formatCurrency(value: number, currency: Currency): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency, maximumFractionDigits: currency === "USD" ? 2 : 0 }).format(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
