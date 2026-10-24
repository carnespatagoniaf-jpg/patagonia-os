// Reporte de ventas a cuenta por período (a pedido de Martínez, feature
// 'reporte_ventas'). Lógica pura.

export type PeriodPreset = "semana_pasada" | "esta_semana" | "ultimos_7" | "este_mes" | "mes_pasado";

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  semana_pasada: "Semana pasada",
  esta_semana: "Esta semana",
  ultimos_7: "Últimos 7 días",
  este_mes: "Este mes",
  mes_pasado: "Mes pasado"
};

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function at(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`);
}

function addDays(isoDate: string, n: number): string {
  return iso(new Date(at(isoDate).getTime() + n * 86400_000));
}

/** Desde y hasta (incluidos) de cada período. La semana va de lunes a domingo. */
export function periodRange(preset: PeriodPreset, today: string): { from: string; to: string } {
  const weekday = (at(today).getUTCDay() + 6) % 7; // lunes = 0
  const monday = addDays(today, -weekday);
  const [y, m] = today.split("-").map(Number);
  switch (preset) {
    case "semana_pasada":
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case "esta_semana":
      return { from: monday, to: today };
    case "ultimos_7":
      return { from: addDays(today, -6), to: today };
    case "este_mes":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "mes_pasado": {
      const first = new Date(Date.UTC(y, m - 2, 1));
      const last = new Date(Date.UTC(y, m - 1, 0));
      return { from: iso(first), to: iso(last) };
    }
  }
}

export interface ReportSale {
  id: string;
  date: string;
  customerId: string;
  customerName: string;
  amount: number;
  reason: string | null;
}

export interface ReportItem {
  chargeId: string;
  name: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  lineTotal: number;
}

export interface SalesSummary {
  count: number;
  total: number;
  /** Kilos vendidos (renglones de productos por kg). */
  kg: number;
  byCustomer: { name: string; count: number; total: number }[];
  byDay: { date: string; total: number; sales: (ReportSale & { items: ReportItem[]; adjustment: number })[] }[];
}

const cents = (n: number) => Math.round(n * 100);

export function summarizeSales(sales: ReportSale[], items: ReportItem[]): SalesSummary {
  const itemsBy = new Map<string, ReportItem[]>();
  for (const it of items) itemsBy.set(it.chargeId, [...(itemsBy.get(it.chargeId) ?? []), it]);

  const customers = new Map<string, { name: string; count: number; total: number }>();
  const days = new Map<string, SalesSummary["byDay"][number]>();
  let total = 0;
  let kg = 0;
  for (const s of [...sales].sort((a, b) => a.date.localeCompare(b.date) || a.customerName.localeCompare(b.customerName))) {
    const lines = itemsBy.get(s.id) ?? [];
    const itemsSum = lines.reduce((a, l) => a + cents(l.lineTotal), 0);
    // Descuento o recargo: lo que el total difiere de la suma de los renglones.
    const adjustment = lines.length ? (cents(s.amount) - itemsSum) / 100 : 0;
    kg += lines.filter((l) => l.unit === "kg").reduce((a, l) => a + l.quantity, 0);
    total += cents(s.amount);
    const c = customers.get(s.customerId) ?? { name: s.customerName, count: 0, total: 0 };
    c.count += 1;
    c.total += cents(s.amount);
    customers.set(s.customerId, c);
    const day = days.get(s.date) ?? { date: s.date, total: 0, sales: [] };
    day.total += cents(s.amount);
    day.sales.push({ ...s, items: lines, adjustment });
    days.set(s.date, day);
  }
  return {
    count: sales.length,
    total: total / 100,
    kg: Math.round(kg * 1000) / 1000,
    byCustomer: [...customers.values()].map((c) => ({ ...c, total: c.total / 100 })).sort((a, b) => b.total - a.total),
    byDay: [...days.values()].map((d) => ({ ...d, total: d.total / 100 }))
  };
}

/** "lun 12/10" */
export function shortDay(isoDate: string): string {
  const names = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  return `${names[at(isoDate).getUTCDay()]} ${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}`;
}
