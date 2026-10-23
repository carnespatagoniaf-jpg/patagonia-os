import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SaleVoucher } from "./accounting-view";
import { computeIibb, invoicedBase } from "./iibb";
import { isBusinessDay, nextBusinessDay, upcomingDues, type OfficialDue } from "./tax-calendar";

const OCT: OfficialDue[] = [
  { month: "2026-10-01", obligation: "iva", digits: "0-1", dueDate: "2026-10-19" },
  { month: "2026-10-01", obligation: "iva", digits: "2-3", dueDate: "2026-10-20" },
  { month: "2026-10-01", obligation: "iva", digits: "8-9", dueDate: "2026-10-23" },
  { month: "2026-10-01", obligation: "monotributo", digits: "todos", dueDate: "2026-10-20" },
  { month: "2026-10-01", obligation: "empleadores", digits: "0-1-2-3", dueDate: "2026-10-09" }
];

describe("vencimientos", () => {
  it("días hábiles", () => {
    assert.equal(isBusinessDay("2026-10-24"), false, "sábado");
    assert.equal(isBusinessDay("2026-11-23"), false, "feriado");
    assert.equal(nextBusinessDay("2026-11-21"), "2026-11-24");
  });

  it("IVA oficial de octubre y estimado de noviembre (CUIT terminado en 2)", () => {
    const r = upcomingDues({
      today: "2026-10-15", cuit: "20-12345678-2", taxCondition: "responsable_inscripto", obligations: null,
      official: OCT, reminders: [], iibbDueDay: null, horizonDays: 40
    });
    const iva = r.items.filter((i) => i.obligation === "iva");
    assert.deepEqual(iva.map((i) => [i.date, i.kind]), [["2026-10-20", "oficial"], ["2026-11-20", "estimada"]]);
    assert.equal(iva[0].daysLeft, 5);
  });

  it("monotributo, recordatorios propios e Ingresos Brutos", () => {
    const r = upcomingDues({
      today: "2026-10-21", cuit: "27182448902", taxCondition: "monotributo", obligations: null,
      official: OCT, reminders: [{ id: "a", title: "Alquiler", dayOfMonth: 31, active: true }, { id: "b", title: "Apagado", dayOfMonth: 25, active: false }],
      iibbDueDay: 15, horizonDays: 35
    });
    // Hasta 35 días (25/11): el alquiler del 30/11 queda afuera; el apagado no aparece.
    // El 31/10 es sábado y el 15/11 domingo: pasan al lunes.
    assert.deepEqual(r.items.map((i) => `${i.date} ${i.title}`), ["2026-11-02 Alquiler", "2026-11-16 Ingresos Brutos", "2026-11-20 Monotributo"]);
    assert.equal(r.items.find((i) => i.title === "Monotributo")?.kind, "estimada");
  });

  it("sin CUIT no puede ubicar el IVA", () => {
    const r = upcomingDues({ today: "2026-10-01", cuit: null, taxCondition: "responsable_inscripto", obligations: null, official: OCT, reminders: [], iibbDueDay: null });
    assert.equal(r.items.length, 0);
    assert.equal(r.missingCuit, true);
  });

  it("obligaciones elegidas a mano (empleadores)", () => {
    const r = upcomingDues({ today: "2026-10-01", cuit: "20123456782", taxCondition: "responsable_inscripto", obligations: ["empleadores"], official: OCT, reminders: [], iibbDueDay: null, horizonDays: 20 });
    assert.deepEqual(r.items.map((i) => i.date), ["2026-10-09"]);
  });
});

const sale = (over: Partial<SaleVoucher>): SaleVoucher => ({
  id: "x", kind: "factura", date: "2026-10-05", voucherType: 6, pointOfSale: 1, number: 1, letter: "B", docType: 99, doc: "0", name: null,
  total: 1210, net: 1000, vat: 210, vatRate: 21, vatLines: null, ...over
});

describe("Ingresos Brutos", () => {
  it("base facturada sin IVA, la nota de crédito resta, la C va entera", () => {
    assert.equal(invoicedBase([sale({}), sale({ voucherType: 8, total: 121, net: 100, vat: 21 }), sale({ letter: "C", voucherType: 11, total: 500, net: 500, vat: 0 })]), 1400);
  });

  it("local: base × alícuota − percepciones − retenciones − créditos", () => {
    const r = computeIibb({
      settings: { regime: "local", jurisdictions: [{ name: "Buenos Aires", rate: 3.5, coefficient: 1 }], base: "invoiced", dueDay: 15 },
      sales: [sale({ total: 121000, net: 100000, vat: 21000 })], systemSales: 0, taxCondition: "responsable_inscripto", defaultVatRate: 21,
      perceptions: 500, bankWithholdings: 700, credits: [{ id: "c", kind: "saldo_a_favor", jurisdiction: null, amount: 300, notes: null }]
    });
    assert.equal(r.tax, 3500);
    assert.equal(r.balance, 2000);
  });

  it("convenio: coeficientes por provincia; base por ventas del sistema sin IVA", () => {
    const r = computeIibb({
      settings: { regime: "convenio", jurisdictions: [{ name: "Buenos Aires", rate: 4, coefficient: 0.7 }, { name: "CABA", rate: 3, coefficient: 0.3 }], base: "sales", dueDay: null },
      sales: [], systemSales: 110500, taxCondition: "responsable_inscripto", defaultVatRate: 10.5,
      perceptions: 0, bankWithholdings: 0, credits: []
    });
    assert.equal(r.base, 100000);
    assert.deepEqual(r.lines.map((l) => [l.base, l.tax]), [[70000, 2800], [30000, 900]]);
    assert.equal(r.balance, 3700);
  });

  it("régimen simplificado: no calcula impuesto", () => {
    const r = computeIibb({ settings: { regime: "simplificado", jurisdictions: [], base: "invoiced", dueDay: null }, sales: [sale({})], systemSales: 0, taxCondition: "monotributo", defaultVatRate: null, perceptions: 100, bankWithholdings: 0, credits: [] });
    assert.equal(r.applies, false);
    assert.equal(r.balance, 0);
  });
});
