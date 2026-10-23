// Carpeta del mes para el contador: las hojas del Excel. Lógica pura (las
// escribe Accounting.tsx con SheetJS). Las notas de crédito van en negativo.
import type { AccountingMonth } from "./accounting-service";
import { isCreditNote, monotributoStatus, purchaseDiscriminatesVat, saleVatLines, vatPosition, voucherNumber, voucherTypeLabel } from "./accounting-view";

export type SheetCell = string | number | null;
export interface Sheet {
  name: string;
  rows: SheetCell[][];
}

const RATES = [10.5, 21, 27, 5, 2.5, 0];
const signed = (type: number, n: number) => (isCreditNote(type) ? -n : n);
const r2 = (n: number) => Math.round(n * 100) / 100;

function rateTitle(rate: number) {
  return String(rate).replace(".", ",") + "%";
}

const CHEQUE_STATUS: Record<string, string> = { in_portfolio: "En cartera", pending: "A debitar" };

export function buildAccountingSheets(m: AccountingMonth): Sheet[] {
  const ri = m.company.taxCondition === "responsable_inscripto";
  const position = vatPosition(m.sales, m.purchases);
  const salesRates = RATES.filter((rate) => m.sales.some((s) => saleVatLines(s).some((l) => l.rate === rate)));
  const purchaseRates = RATES.filter((rate) => m.purchases.some((p) => p.vatLines.some((l) => l.rate === rate)));

  const summary: SheetCell[][] = [
    ["Carpeta del mes para el contador"],
    ["Negocio", m.company.businessName || m.company.name],
    ["CUIT", m.company.cuit],
    ["Condición frente al IVA", ri ? "Responsable inscripto" : m.company.taxCondition === "monotributo" ? "Monotributo" : "Sin datos fiscales"],
    ["Período", `${m.period} al ${m.periodEnd}`],
    [],
    ["Ventas del mes registradas en el sistema"],
    ["Mostrador", r2(m.monthSales.pos)],
    ["A cuenta (Clientes)", r2(m.monthSales.account)],
    ["Comprobantes autorizados por ARCA", m.sales.length],
    ["Total facturado (notas de crédito restadas)", r2(m.sales.reduce((s, x) => s + signed(x.voucherType, x.total), 0))],
    []
  ];
  if (ri) {
    summary.push(
      ["Posición de IVA (estimada; la confirma el contador en el F. 2002)"],
      ["IVA de las ventas (débito fiscal)", position.debit],
      ["IVA de las compras (crédito fiscal)", position.credit],
      ["Percepciones de IVA sufridas", position.perceptions],
      [position.balance >= 0 ? "Saldo a pagar" : "Saldo a favor", Math.abs(position.balance)],
      []
    );
  } else {
    const st = monotributoStatus(m.monotributo.invoiced12m, m.monotributo.categories);
    summary.push(
      ["Monotributo (últimos 12 meses)", `${m.monotributo.from} al ${m.monotributo.to}`],
      ["Facturado electrónicamente", r2(m.monotributo.invoiced12m)],
      ["Ventas registradas en el sistema", r2(m.monotributo.sales12m)],
      ["Categoría que corresponde por lo facturado", st.category ?? "Supera la K"],
      ["Tope de esa categoría", st.limit],
      ["Escala vigente desde", m.monotributo.categoriesFrom],
      []
    );
  }
  summary.push(
    ["Compras con factura cargada", m.purchases.length],
    ["Compras del mes sin factura cargada", m.purchasesWithoutVoucher.length],
    ["Gastos del mes", r2(m.expenses.reduce((s, e) => s + e.total, 0))],
    ["Sueldos pagados", r2(m.payroll.salaries)],
    ["Adelantos y vales", r2(m.payroll.advances)],
    ["Pagos a proveedores", r2(m.supplierPayments)]
  );

  const sales: SheetCell[][] = [
    ["Fecha", "Comprobante", "Número", "Documento", "Cliente", ...salesRates.flatMap((r) => [`Neto ${rateTitle(r)}`, `IVA ${rateTitle(r)}`]), "Neto", "IVA", "Total"]
  ];
  for (const s of m.sales) {
    const lines = saleVatLines(s);
    const docLabel = s.docType === 99 ? "Consumidor final" : `${s.docType === 80 ? "CUIT" : "DNI"} ${s.doc}`;
    sales.push([
      s.date,
      voucherTypeLabel(s.voucherType),
      voucherNumber(s.pointOfSale, s.number),
      docLabel,
      s.name ?? "",
      ...salesRates.flatMap((rate) => {
        const l = lines.find((x) => x.rate === rate);
        return [l ? signed(s.voucherType, l.net) : null, l ? signed(s.voucherType, l.vat) : null];
      }),
      signed(s.voucherType, lines.length ? r2(lines.reduce((a, l) => a + l.net, 0)) : s.total),
      signed(s.voucherType, r2(lines.reduce((a, l) => a + l.vat, 0))),
      signed(s.voucherType, s.total)
    ]);
  }

  const purchases: SheetCell[][] = [
    ["Fecha", "Comprobante", "Número", "CUIT", "Proveedor", ...purchaseRates.flatMap((r) => [`Neto ${rateTitle(r)}`, `IVA ${rateTitle(r)}`]),
     "No gravado", "Exento", "Percepción IVA", "Percepción IIBB", "Imp. internos", "Otros", "Total", "Crédito fiscal", "Origen"]
  ];
  for (const p of m.purchases) {
    const k = (n: number) => signed(p.voucherType, n);
    purchases.push([
      p.voucherDate,
      voucherTypeLabel(p.voucherType),
      voucherNumber(p.pointOfSale, p.number),
      p.sellerDoc,
      p.sellerName,
      ...purchaseRates.flatMap((rate) => {
        const l = p.vatLines.find((x) => x.rate === rate);
        return [l ? k(l.net) : null, l ? k(l.vat) : null];
      }),
      k(p.noTaxed), k(p.exempt), k(p.percVat), k(p.percIibb), k(p.internalTaxes), k(p.otherTaxes), k(p.total),
      purchaseDiscriminatesVat(p.voucherType) ? k(p.vatTotal) : 0,
      p.source === "arca" ? "ARCA (Mis Comprobantes)" : p.source === "compras" ? "Compras" : "Cargada a mano"
    ]);
  }

  const without: SheetCell[][] = [["Fecha", "Proveedor", "CUIT", "N.º de factura (en Compras)", "Total"]];
  for (const p of m.purchasesWithoutVoucher) without.push([p.date, p.supplier ?? "", p.supplierTaxId ?? "", p.invoiceNumber ?? "", p.total]);

  const expenses: SheetCell[][] = [["Categoría", "Total"], ...m.expenses.map((e) => [e.category, r2(e.total)] as SheetCell[])];
  expenses.push(["Sueldos", r2(m.payroll.salaries)], ["Adelantos y vales", r2(m.payroll.advances)]);

  const accounts: SheetCell[][] = [[`Saldo al ${m.periodEnd}`, "Saldo"], ...m.accounts.map((a) => [a.name, r2(a.balance)] as SheetCell[])];
  const receivables: SheetCell[][] = [["Cliente (saldo de hoy)", "CUIT", "Te debe"], ...m.receivables.map((r) => [r.name, r.taxId ?? "", r2(r.balance)] as SheetCell[])];
  const payables: SheetCell[][] = [["Proveedor (saldo de hoy)", "CUIT", "Le debés"], ...m.payables.map((r) => [r.name, r.taxId ?? "", r2(r.balance)] as SheetCell[])];
  const debts: SheetCell[][] = [["Deuda (saldo de hoy)", "Saldo"], ...m.debts.map((r) => [r.name, r2(r.balance)] as SheetCell[])];
  const cheques: SheetCell[][] = [
    ["Tipo", "Estado", "Número", "Banco", "Librador", "Fecha de pago", "Importe"],
    ...m.cheques.map((c) => [c.kind === "received" ? "Recibido" : "Propio", CHEQUE_STATUS[c.status] ?? c.status, c.number ?? "", c.bank ?? "", c.drawer ?? "", c.payDate ?? "", r2(c.amount)] as SheetCell[])
  ];
  const stock: SheetCell[][] = [["Sucursal (stock de hoy, a costo)", "Valor"], ...m.stock.map((s) => [s.branch, r2(s.value)] as SheetCell[])];

  return [
    { name: "Resumen", rows: summary },
    { name: "IVA Ventas", rows: sales },
    { name: "IVA Compras", rows: purchases },
    { name: "Compras sin factura", rows: without },
    { name: "Gastos y sueldos", rows: expenses },
    { name: "Cuentas", rows: accounts },
    { name: "Clientes", rows: receivables },
    { name: "Proveedores", rows: payables },
    { name: "Deudas", rows: debts },
    { name: "Cheques", rows: cheques },
    { name: "Stock", rows: stock }
  ];
}
