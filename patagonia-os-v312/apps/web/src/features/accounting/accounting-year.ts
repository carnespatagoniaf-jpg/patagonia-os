// Resumen del ejercicio para el contador (Ganancias, Bienes Personales,
// balance): los 12 meses en un Excel. Se arma con accounting_month de cada
// mes, sin consultas nuevas. Lógica pura.
import type { AccountingMonth, InventorySnapshot } from "./accounting-service";
import type { Sheet, SheetCell } from "./accounting-export";
import { isCreditNote, monotributoStatus, saleVatLines, vatPosition } from "./accounting-view";
import { computeIibb } from "./iibb";

const r2 = (n: number) => Math.round(n * 100) / 100;
const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

/** Los 12 meses ("AAAA-MM") del ejercicio que cierra en endMonth, sin los que todavía no empezaron. */
export function fiscalYearMonths(endMonth: string, today: string): string[] {
  const [y, m] = endMonth.split("-").map(Number);
  const out: string[] = [];
  for (let k = 11; k >= 0; k--) {
    const d = new Date(Date.UTC(y, m - 1 - k, 1));
    const month = d.toISOString().slice(0, 7);
    if (month <= today.slice(0, 7)) out.push(month);
  }
  return out;
}

/** Primer día del ejercicio y último día (AAAA-MM-DD). */
export function fiscalYearRange(endMonth: string): { start: string; end: string; dayBefore: string } {
  const [y, m] = endMonth.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 12, 1));
  const end = new Date(Date.UTC(y, m, 0));
  const dayBefore = new Date(start.getTime() - 86400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), dayBefore: dayBefore.toISOString().slice(0, 10) };
}

function monthTitle(period: string): string {
  return `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(2, 4)}`;
}

export interface YearRow {
  period: string;
  posSales: number;
  accountSales: number;
  invoicedTotal: number;
  invoicedNet: number;
  invoicedVat: number;
  purchasesWithVoucher: number;
  purchasesWithoutVoucher: number;
  expenses: number;
  salaries: number;
  advances: number;
  supplierPayments: number;
  vatDebit: number;
  vatCredit: number;
  vatPerceptions: number;
  vatBalance: number;
  iibbTax: number | null;
  iibbBalance: number | null;
}

export function yearRows(months: AccountingMonth[]): YearRow[] {
  return months.map((m) => {
    let total = 0;
    let net = 0;
    let vat = 0;
    for (const s of m.sales) {
      const k = isCreditNote(s.voucherType) ? -1 : 1;
      const lines = saleVatLines(s);
      total += k * Math.round(s.total * 100);
      net += k * Math.round((lines.length ? lines.reduce((a, l) => a + l.net, 0) : s.total) * 100);
      vat += k * Math.round(lines.reduce((a, l) => a + l.vat, 0) * 100);
    }
    const pos = vatPosition(m.sales, m.purchases);
    const iibb = m.iibb.settings
      ? computeIibb({
          settings: m.iibb.settings,
          sales: m.sales,
          systemSales: m.monthSales.pos + m.monthSales.account,
          taxCondition: m.company.taxCondition,
          defaultVatRate: m.company.defaultVatRate,
          perceptions: m.iibb.perceptions,
          bankWithholdings: m.iibb.bankWithholdings,
          credits: m.iibb.credits
        })
      : null;
    return {
      period: m.period,
      posSales: r2(m.monthSales.pos),
      accountSales: r2(m.monthSales.account),
      invoicedTotal: total / 100,
      invoicedNet: net / 100,
      invoicedVat: vat / 100,
      purchasesWithVoucher: r2(m.purchases.reduce((a, p) => a + (isCreditNote(p.voucherType) ? -p.total : p.total), 0)),
      purchasesWithoutVoucher: r2(m.purchasesWithoutVoucher.reduce((a, p) => a + p.total, 0)),
      expenses: r2(m.expenses.reduce((a, e) => a + e.total, 0)),
      salaries: r2(m.payroll.salaries),
      advances: r2(m.payroll.advances),
      supplierPayments: r2(m.supplierPayments),
      vatDebit: pos.debit,
      vatCredit: pos.credit,
      vatPerceptions: pos.perceptions,
      vatBalance: pos.balance,
      iibbTax: iibb?.applies ? iibb.tax : null,
      iibbBalance: iibb?.applies ? iibb.balance : null
    };
  });
}

function sum(rows: YearRow[], key: keyof YearRow): number {
  return r2(rows.reduce((a, r) => a + Number(r[key] ?? 0), 0));
}

/** Busca el inventario guardado justo en esa fecha. */
function snapshotOn(snapshots: InventorySnapshot[], date: string): InventorySnapshot | null {
  return snapshots.find((s) => s.takenOn === date) ?? null;
}

export function buildYearSheets(input: { endMonth: string; months: AccountingMonth[]; snapshots: InventorySnapshot[] }): Sheet[] {
  const { months } = input;
  if (months.length === 0) return [];
  const last = months[months.length - 1];
  const company = last.company;
  const ri = company.taxCondition === "responsable_inscripto";
  const range = fiscalYearRange(input.endMonth);
  const rows = yearRows(months);
  const dates = (iso: string) => iso.split("-").reverse().join("/");

  const head: SheetCell[][] = [
    ["Resumen del ejercicio para el contador"],
    ["Negocio", company.businessName || company.name],
    ["CUIT", company.cuit],
    ["Condición frente al IVA", ri ? "Responsable inscripto" : company.taxCondition === "monotributo" ? "Monotributo" : "Sin datos fiscales"],
    ["Ejercicio", `${dates(range.start)} al ${dates(range.end)}`],
    rows.length < 12 ? [`Incluye ${rows.length} meses (los que ya pasaron).`] : [],
    []
  ];

  const columns: [keyof YearRow, string][] = [
    ["posSales", "Ventas Mostrador"],
    ["accountSales", "Ventas a cuenta"],
    ["invoicedTotal", "Facturado (total)"],
    ["invoicedNet", "Facturado (neto)"],
    ["invoicedVat", "IVA facturado"],
    ["purchasesWithVoucher", "Compras con factura"],
    ["purchasesWithoutVoucher", "Compras sin factura cargada"],
    ["expenses", "Gastos"],
    ["salaries", "Sueldos"],
    ["advances", "Adelantos y vales"],
    ["supplierPayments", "Pagos a proveedores"]
  ];
  const summary: SheetCell[][] = [
    ...head,
    ["Mes", ...columns.map((c) => c[1])],
    ...rows.map((r) => [monthTitle(r.period), ...columns.map(([k]) => Number(r[k] ?? 0))] as SheetCell[]),
    ["Total", ...columns.map(([k]) => sum(rows, k))]
  ];

  // Gastos: categoría × mes.
  const categories = [...new Set(months.flatMap((m) => m.expenses.map((e) => e.category)))].sort();
  const expenses: SheetCell[][] = [
    ["Categoría", ...months.map((m) => monthTitle(m.period)), "Total"],
    ...categories.map((cat) => {
      const vals = months.map((m) => r2(m.expenses.filter((e) => e.category === cat).reduce((a, e) => a + e.total, 0)));
      return [cat, ...vals, r2(vals.reduce((a, b) => a + b, 0))] as SheetCell[];
    }),
    ["Sueldos", ...rows.map((r) => r.salaries), sum(rows, "salaries")],
    ["Adelantos y vales", ...rows.map((r) => r.advances), sum(rows, "advances")]
  ];

  const sheets: Sheet[] = [
    { name: "Resumen del ejercicio", rows: summary },
    { name: "Gastos por categoría", rows: expenses }
  ];

  if (ri) {
    sheets.push({
      name: "IVA por mes",
      rows: [
        ["Mes", "IVA ventas (débito)", "IVA compras (crédito)", "Percepciones de IVA", "Saldo (+ a pagar / − a favor)"],
        ...rows.map((r) => [monthTitle(r.period), r.vatDebit, r.vatCredit, r.vatPerceptions, r.vatBalance] as SheetCell[]),
        ["Total", sum(rows, "vatDebit"), sum(rows, "vatCredit"), sum(rows, "vatPerceptions"), sum(rows, "vatBalance")],
        [],
        ["Estimado con lo cargado en el sistema; el saldo real sale de las declaraciones juradas presentadas."]
      ]
    });
  } else if (company.taxCondition === "monotributo") {
    const st = monotributoStatus(last.monotributo.invoiced12m, last.monotributo.categories);
    sheets.push({
      name: "Monotributo",
      rows: [
        ["Facturado en los 12 meses", r2(last.monotributo.invoiced12m)],
        ["Ventas registradas en el sistema en los 12 meses", r2(last.monotributo.sales12m)],
        ["Categoría que corresponde por lo facturado", st.category ?? "Supera la K"],
        ["Tope de esa categoría", st.limit],
        ["Escala vigente desde", last.monotributo.categoriesFrom]
      ]
    });
  }

  if (rows.some((r) => r.iibbTax !== null)) {
    sheets.push({
      name: "Ingresos Brutos por mes",
      rows: [
        ["Mes", "Impuesto", "A pagar (estimado)"],
        ...rows.map((r) => [monthTitle(r.period), r.iibbTax, r.iibbBalance] as SheetCell[]),
        ["Total", sum(rows, "iibbTax"), sum(rows, "iibbBalance")]
      ]
    });
  }

  const startInv = snapshotOn(input.snapshots, range.dayBefore);
  const endInv = snapshotOn(input.snapshots, range.end);
  sheets.push({
    name: "Inventario",
    rows: [
      ["Inventario", "Fecha", "Valor al costo"],
      ["Al inicio del ejercicio", dates(range.dayBefore), startInv ? startInv.totalValue : "No está guardado: Contable → Inventario al cierre, con esa fecha"],
      ["Al cierre del ejercicio", dates(range.end), endInv ? endInv.totalValue : "No está guardado: Contable → Inventario al cierre, con esa fecha"],
      [],
      ["El detalle por producto se baja desde Contable → Inventario al cierre."]
    ]
  });

  sheets.push({
    name: "Saldos al cierre",
    rows: [
      [`Cuentas (saldo al ${dates(last.periodEnd)})`, "Saldo"],
      ...last.accounts.map((a) => [a.name, r2(a.balance)] as SheetCell[]),
      [],
      ["Clientes que deben (saldo de hoy)", r2(last.receivables.reduce((a, r) => a + r.balance, 0))],
      ["Deuda con proveedores (saldo de hoy)", r2(last.payables.reduce((a, r) => a + r.balance, 0))],
      ["Otras deudas (saldo de hoy)", r2(last.debts.reduce((a, r) => a + r.balance, 0))],
      ["Cheques en cartera (hoy)", r2(last.cheques.filter((c) => c.kind === "received").reduce((a, c) => a + c.amount, 0))],
      ["Cheques propios a debitar (hoy)", r2(last.cheques.filter((c) => c.kind === "issued").reduce((a, c) => a + c.amount, 0))]
    ]
  });
  return sheets;
}
