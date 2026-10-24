import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountingMonth } from "./accounting-service";
import { buildYearSheets, fiscalYearMonths, fiscalYearRange, yearRows } from "./accounting-year";

function month(period: string, over: Partial<AccountingMonth> = {}): AccountingMonth {
  return {
    period: `${period}-01`,
    periodEnd: `${period}-28`,
    company: { name: "Carnicería", cuit: "20123456786", businessName: "Carnicería SRL", taxCondition: "responsable_inscripto", pointOfSale: 1, invoicingEnabled: true, defaultVatRate: 10.5 },
    sales: [
      { id: "s", kind: "factura", date: `${period}-05`, voucherType: 6, pointOfSale: 1, number: 1, letter: "B", docType: 99, doc: "0", name: null, total: 1105, net: 1000, vat: 105, vatRate: 10.5, vatLines: null },
      { id: "n", kind: "nota_credito", date: `${period}-06`, voucherType: 8, pointOfSale: 1, number: 2, letter: "B", docType: 99, doc: "0", name: null, total: 110.5, net: 100, vat: 10.5, vatRate: 10.5, vatLines: null }
    ],
    purchases: [],
    purchasesWithoutVoucher: [{ id: "p", date: `${period}-03`, supplierId: null, supplier: "X", supplierTaxId: null, invoiceNumber: null, total: 500 }],
    monotributo: { from: "", to: "", invoiced12m: 0, sales12m: 0, categories: [], categoriesFrom: null },
    monthSales: { pos: 2000, account: 300 },
    expenses: [{ category: "Luz", total: 100 }],
    payroll: { salaries: 400, advances: 50 },
    supplierPayments: 450,
    accounts: [{ name: "Efectivo", kind: "cash", balance: 900 }],
    receivables: [{ name: "Cliente", taxId: null, balance: 70 }],
    payables: [],
    debts: [],
    cheques: [],
    stock: [],
    iibb: { settings: { regime: "local", jurisdictions: [{ name: "Buenos Aires", rate: 3.5, coefficient: 1 }], base: "invoiced", dueDay: 15, obligations: null }, perceptions: 0, bankWithholdings: 0, bankWithholdingLines: 0, credits: [] },
    ...over
  };
}

describe("resumen del ejercicio", () => {
  it("los 12 meses del ejercicio, sin los que no empezaron", () => {
    assert.deepEqual(fiscalYearMonths("2026-12", "2026-10-23").slice(0, 2), ["2026-01", "2026-02"]);
    assert.equal(fiscalYearMonths("2026-12", "2026-10-23").length, 10);
    assert.equal(fiscalYearMonths("2026-06", "2026-10-23")[0], "2025-07");
    assert.deepEqual(fiscalYearRange("2026-06"), { start: "2025-07-01", end: "2026-06-30", dayBefore: "2025-06-30" });
  });

  it("filas por mes: la nota de crédito resta, IVA e IIBB del mes", () => {
    const [r] = yearRows([month("2026-01")]);
    assert.equal(r.invoicedTotal, 994.5);
    assert.equal(r.invoicedNet, 900);
    assert.equal(r.invoicedVat, 94.5);
    assert.equal(r.vatBalance, 94.5);
    assert.equal(r.iibbTax, 31.5);
    assert.equal(r.purchasesWithoutVoucher, 500);
  });

  it("el Excel: totales del año, gastos por categoría, inventario de inicio y cierre", () => {
    const sheets = buildYearSheets({
      endMonth: "2026-12",
      months: [month("2026-01"), month("2026-02", { expenses: [{ category: "Alquiler", total: 1000 }] })],
      snapshots: [{ id: "i", takenOn: "2026-12-31", label: null, totalValue: 12345, itemsCount: 3, createdAt: "" }]
    });
    assert.deepEqual(sheets.map((s) => s.name), ["Resumen del ejercicio", "Gastos por categoría", "IVA por mes", "Ingresos Brutos por mes", "Inventario", "Saldos al cierre"]);
    const total = sheets[0].rows.find((r) => r[0] === "Total")!;
    assert.equal(total[1], 4000, "ventas Mostrador de los 2 meses");
    const gastos = sheets[1].rows;
    assert.deepEqual(gastos[0], ["Categoría", "Ene 26", "Feb 26", "Total"]);
    assert.deepEqual(gastos.find((r) => r[0] === "Luz"), ["Luz", 100, 0, 100]);
    const inv = sheets[4].rows;
    assert.match(String(inv[1][2]), /No está guardado/);
    assert.equal(inv[2][2], 12345);
  });

  it("monotributista: hoja de monotributo en vez de IVA", () => {
    const m = month("2026-01", {
      company: { name: "Mono", cuit: "20123456786", businessName: null, taxCondition: "monotributo", pointOfSale: 1, invoicingEnabled: true, defaultVatRate: null },
      monotributo: { from: "", to: "", invoiced12m: 5000000, sales12m: 6000000, categories: [{ category: "A", maxIncome: 12009410.45 }], categoriesFrom: "2026-08-01" },
      iibb: { settings: null, perceptions: 0, bankWithholdings: 0, bankWithholdingLines: 0, credits: [] }
    });
    const sheets = buildYearSheets({ endMonth: "2026-12", months: [m], snapshots: [] });
    assert.ok(sheets.some((s) => s.name === "Monotributo"));
    assert.ok(!sheets.some((s) => s.name === "IVA por mes" || s.name === "Ingresos Brutos por mes"));
  });
});
