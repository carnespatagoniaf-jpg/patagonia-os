import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { periodRange, shortDay, summarizePayments, summarizeSales } from "./sales-report";

describe("reporte de ventas", () => {
  it("períodos (viernes 23/10/2026)", () => {
    assert.deepEqual(periodRange("semana_pasada", "2026-10-23"), { from: "2026-10-12", to: "2026-10-18" });
    assert.deepEqual(periodRange("esta_semana", "2026-10-23"), { from: "2026-10-19", to: "2026-10-23" });
    assert.deepEqual(periodRange("ultimos_7", "2026-10-23"), { from: "2026-10-17", to: "2026-10-23" });
    assert.deepEqual(periodRange("mes_pasado", "2026-10-23"), { from: "2026-09-01", to: "2026-09-30" });
    assert.deepEqual(periodRange("semana_pasada", "2026-10-19"), { from: "2026-10-12", to: "2026-10-18" }, "un lunes");
    assert.deepEqual(periodRange("semana_pasada", "2026-10-25"), { from: "2026-10-12", to: "2026-10-18" }, "un domingo");
    assert.equal(shortDay("2026-10-12"), "lun 12/10");
  });

  it("totales por cliente y por día, kilos, y el descuento como diferencia", () => {
    const s = summarizeSales(
      [
        { id: "a", date: "2026-10-13", customerId: "c1", customerName: "Juan", amount: 9500, reason: null },
        { id: "b", date: "2026-10-12", customerId: "c2", customerName: "Pedro", amount: 3000, reason: "media res" },
        { id: "c", date: "2026-10-13", customerId: "c1", customerName: "Juan", amount: 500, reason: null }
      ],
      [
        { chargeId: "a", name: "Media res", quantity: 50, unit: "kg", unitPrice: 200, lineTotal: 10000 },
        { chargeId: "b", name: "Pollo", quantity: 3, unit: "unit", unitPrice: 1000, lineTotal: 3000 }
      ]
    );
    assert.equal(s.count, 3);
    assert.equal(s.total, 13000);
    assert.equal(s.kg, 50);
    assert.deepEqual(s.byCustomer, [{ name: "Juan", count: 2, total: 10000 }, { name: "Pedro", count: 1, total: 3000 }]);
    assert.deepEqual(s.byDay.map((d) => [d.date, d.total]), [["2026-10-12", 3000], ["2026-10-13", 10000]]);
    assert.equal(s.byDay[1].sales[0].adjustment, -500, "descuento de 500");
    assert.equal(s.byDay[1].sales[1].adjustment, 0, "sin renglones no hay ajuste");
  });
});

describe("reporte de pagos de clientes", () => {
  it("total cobrado, por cuenta, por cliente y por día, sin errores de centavos", () => {
    const s = summarizePayments([
      { id: "1", date: "2026-11-16", customerId: "c1", customerName: "Juan", amount: 100.1, accountName: "Efectivo", notes: null },
      { id: "2", date: "2026-11-15", customerId: "c2", customerName: "Pedro", amount: 200.2, accountName: "Banco", notes: "transferencia" },
      { id: "3", date: "2026-11-16", customerId: "c1", customerName: "Juan", amount: 0.7, accountName: "Efectivo", notes: null },
      { id: "4", date: "2026-11-17", customerId: "c3", customerName: "Ana", amount: 50, accountName: null, notes: null }
    ]);
    assert.equal(s.count, 4);
    assert.equal(s.total, 351);
    assert.deepEqual(s.byAccount, [
      { name: "Banco", count: 1, total: 200.2 },
      { name: "Efectivo", count: 2, total: 100.8 },
      { name: "Sin cuenta", count: 1, total: 50 }
    ]);
    assert.deepEqual(s.byCustomer.map((c) => [c.name, c.count, c.total]), [["Pedro", 1, 200.2], ["Juan", 2, 100.8], ["Ana", 1, 50]]);
    assert.deepEqual(s.byDay.map((d) => [d.date, d.total, d.payments.length]), [["2026-11-15", 200.2, 1], ["2026-11-16", 100.8, 2], ["2026-11-17", 50, 1]]);
  });

  it("sin pagos, todo en cero", () => {
    const s = summarizePayments([]);
    assert.equal(s.count, 0);
    assert.equal(s.total, 0);
    assert.equal(s.byDay.length, 0);
  });
});
