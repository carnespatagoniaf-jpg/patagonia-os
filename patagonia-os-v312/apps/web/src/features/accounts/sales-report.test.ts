import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { periodRange, shortDay, summarizeSales } from "./sales-report";

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
