import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { daysWaiting, suggestMatches, type MatchMovement } from "./reconcile-match";

const venta = (id: string, date: string, amount: number): MatchMovement => ({ id, date, direction: "in", amount, movementType: "venta" });

describe("cruce banco ↔ Tesorería", () => {
  it("uno a uno: mismo importe, fecha cercana, elige el más cercano", () => {
    const suggestions = suggestMatches(
      [{ id: "L1", date: "2026-09-02", amount: 25000, description: "TRANSFERENCIA" }],
      [
        { id: "M-lejos", date: "2026-08-20", direction: "in", amount: 25000, movementType: "cobro_cliente" },
        { id: "M-cerca", date: "2026-09-02", direction: "in", amount: 25000, movementType: "cobro_cliente" }
      ]
    );
    assert.deepEqual(suggestions.map((s) => [s.lineId, s.movementIds, s.kind]), [["L1", ["M-cerca"], "exact"]]);
  });

  it("no cruza entradas con salidas del mismo importe", () => {
    const suggestions = suggestMatches(
      [{ id: "L1", date: "2026-09-02", amount: -5000, description: "PAGO" }],
      [venta("M1", "2026-09-02", 5000)]
    );
    assert.equal(suggestions.length, 0);
  });

  it("un movimiento no se usa para dos líneas", () => {
    const suggestions = suggestMatches(
      [
        { id: "L1", date: "2026-09-02", amount: -100, description: "COMISION" },
        { id: "L2", date: "2026-09-02", amount: -100, description: "COMISION" }
      ],
      [{ id: "M1", date: "2026-09-02", direction: "out", amount: 100, movementType: "gasto" }]
    );
    assert.equal(suggestions.length, 1);
  });

  it("depósito del posnet = ventas de un día exactas", () => {
    const suggestions = suggestMatches(
      [{ id: "L1", date: "2026-09-04", amount: 30000, description: "ACRED. DEBITO" }],
      [venta("A", "2026-09-03", 10000), venta("B", "2026-09-03", 20000), venta("C", "2026-09-02", 7000)]
    );
    assert.deepEqual(suggestions.map((s) => [s.kind, s.movementIds.sort(), s.fee]), [["day_total", ["A", "B"], 0]]);
  });

  it("depósito del posnet con comisión descontada: sugiere el día y la diferencia como comisión", () => {
    const suggestions = suggestMatches(
      [{ id: "L1", date: "2026-09-25", amount: 96450.3, description: "LIQUIDACION VISA" }],
      [venta("A", "2026-09-05", 60000), venta("B", "2026-09-05", 40000), venta("C", "2026-09-06", 5000), venta("D", "2026-09-06", 5000)]
    );
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].kind, "day_total_fee");
    assert.deepEqual(suggestions[0].movementIds.sort(), ["A", "B"]);
    assert.equal(suggestions[0].fee, 3549.7);
  });

  it("no sugiere si la diferencia es demasiado grande para ser una comisión", () => {
    const suggestions = suggestMatches(
      [{ id: "L1", date: "2026-09-10", amount: 50000, description: "DEPOSITO" }],
      [venta("A", "2026-09-05", 60000), venta("B", "2026-09-05", 40000)]
    );
    assert.equal(suggestions.length, 0);
  });

  it("días esperando acreditación", () => {
    assert.equal(daysWaiting("2026-09-01", "2026-09-30"), 29);
  });
});
