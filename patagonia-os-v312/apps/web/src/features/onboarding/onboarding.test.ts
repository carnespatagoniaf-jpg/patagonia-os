import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { onboardingSteps } from "./onboarding";

describe("Primeros pasos", () => {
  it("un cliente nuevo tiene los 4 pasos pendientes, en orden", () => {
    const steps = onboardingSteps({ products: 0, stockLoaded: false, sales: 0, closedShifts: 0 });
    assert.deepEqual(steps.map((s) => [s.key, s.done]), [["productos", false], ["stock", false], ["venta", false], ["cierre", false]]);
  });
  it("con 2 productos todavía no cuenta como cargado; con 5 sí", () => {
    assert.equal(onboardingSteps({ products: 2, stockLoaded: false, sales: 0, closedShifts: 0 })[0].done, false);
    assert.equal(onboardingSteps({ products: 5, stockLoaded: false, sales: 0, closedShifts: 0 })[0].done, true);
  });
  it("un cliente que ya vende y cierra caja tiene todo hecho (la tarjeta no aparece)", () => {
    assert.ok(onboardingSteps({ products: 120, stockLoaded: true, sales: 900, closedShifts: 40 }).every((s) => s.done));
  });
});
