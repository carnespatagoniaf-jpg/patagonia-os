import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { daysWaiting, groupSimilarLines, isCardDeposit, isTaxLine, suggestMatches, summarizeCards, type SystemItem } from "./reconcile-match";

const cobro = (id: string, date: string, amount: number, isCard = false): SystemItem => ({ id, source: "payment", date, amount, isCard, label: "Cobro" });

describe("cruce banco ↔ sistema (formatos del Banco Provincia real)", () => {
  it("transferencia: mismo importe, el banco la muestra 1 día después", () => {
    const s = suggestMatches(
      [{ id: "L1", date: "2026-09-30", amount: 17839, description: "TRANSF DE CLIENTE (20294029789) VAR" }],
      [cobro("C1", "2026-09-29", 17839)]
    );
    assert.deepEqual(s, [{ lineId: "L1", itemIds: ["C1"], kind: "exact" }]);
  });

  it("dos transferencias del mismo importe van cada una a su cobro, sin repetir", () => {
    const s = suggestMatches(
      [
        { id: "L1", date: "2026-09-29", amount: 17839, description: "TRANSF DE A" },
        { id: "L2", date: "2026-09-30", amount: 17839, description: "TRANSF DE B" }
      ],
      [cobro("C1", "2026-09-29", 17839), cobro("C2", "2026-09-29", 17839)]
    );
    assert.equal(s.length, 2);
    assert.notEqual(s[0].itemIds[0], s[1].itemIds[0]);
  });

  it("no cruza fuera de la ventana de días", () => {
    const s = suggestMatches([{ id: "L1", date: "2026-09-30", amount: 5000, description: "TRANSF DE X" }], [cobro("C1", "2026-09-10", 5000)]);
    assert.equal(s.length, 0);
  });

  it("salida del banco contra pago a proveedor (movimiento con signo negativo)", () => {
    const s = suggestMatches(
      [{ id: "L1", date: "2026-09-11", amount: -80000, description: "TRANSF A PROVEEDOR" }],
      [{ id: "M1", source: "movement", date: "2026-09-11", amount: -80000, isCard: false, label: "Pago a proveedor" }]
    );
    assert.equal(s.length, 1);
  });

  it("las tarjetas no se cruzan una a una", () => {
    const s = suggestMatches(
      [{ id: "L1", date: "2026-09-30", amount: 30000, description: "PAGOS A COMERCIOS VISA - L. 0000300258 - C. 00005683628" }],
      [cobro("C1", "2026-09-29", 30000, true)]
    );
    assert.equal(s.length, 0);
  });

  it("reconoce acreditaciones de tarjeta e impuestos", () => {
    assert.equal(isCardDeposit({ amount: 89420.91, description: "PAGOS A COMERCIOS VISA - L. 0000300258 - C. 00005683628" }), true);
    assert.equal(isCardDeposit({ amount: 5000, description: "TRANSF DE JUAN" }), false);
    assert.equal(isTaxLine({ amount: -963.39, description: "IMPUESTO CREDITO -LEY 25413" }), true);
    assert.equal(isTaxLine({ amount: -400000, description: "DB.DEBIN 30/09-S.237200" }), false);
  });

  it("resumen de tarjetas por período", () => {
    const r = summarizeCards([cobro("C1", "2026-09-17", 60000, true), cobro("C2", "2026-09-18", 40000, true)], [{ id: "L1", date: "2026-09-19", amount: 96000, description: "PAGOS A COMERCIOS" }]);
    assert.equal(r.sold, 100000);
    assert.equal(r.deposited, 96000);
    assert.equal(r.difference, 4000);
    assert.equal(r.differencePct, 4);
  });

  it("agrupa líneas iguales (ej. el impuesto Ley 25413 de todo el mes)", () => {
    const lines = [1, 2, 3].map((n) => ({ id: `L${n}`, date: `2026-09-0${n}`, amount: -100 * n, description: "IMPUESTO CREDITO -LEY 25413" }));
    const groups = groupSimilarLines([...lines, { id: "X", date: "2026-09-01", amount: -5, description: "OTRA COSA" }]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].lines.length, 3);
    assert.equal(groups[0].total, -600);
  });

  it("días esperando", () => {
    assert.equal(daysWaiting("2026-09-01", "2026-09-30"), 29);
  });
});
