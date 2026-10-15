import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chargedTicketWarning, hourAr, undoVoidQuestion, voidedTicketQuestion } from "./scale-void-warning";

// Casos reales de Haedo (horas en UTC = Argentina + 3).
const mila = { createdAt: "2026-10-13T17:14:04.921Z", amount: 9780, by: "Caja Haedo" };
const suprema = { createdAt: "2026-10-06T22:45:04.570Z", amount: 11481.4, by: null };

describe("avisos anulado y cobrado (control de balanza)", () => {
  it("hora argentina, sin depender del huso de la PC", () => {
    assert.equal(hourAr(mila.createdAt), "14:14");
    assert.equal(hourAr(suprema.createdAt), "19:45");
  });

  it("Mostrador: papel anulado que se vuelve a escanear", () => {
    const q = voidedTicketQuestion(mila);
    assert.match(q, /^Este ticket fue anulado a las 14:14 por Caja Haedo/);
    assert.match(q, /¿Cobrarlo igual\?$/);
    assert.match(undoVoidQuestion(mila), /Deshacer la anulación de las 14:14/);
  });

  it("Anular: papel que ya se cobró (sin nombre no dice 'por')", () => {
    const w = chargedTicketWarning(suprema);
    assert.match(w, /^Este ticket ya se cobró a las 19:45 \(/);
    assert.doesNotMatch(w, / por /);
  });
});
