import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { carcassYield } from "./carcass-yield";

describe("carcassYield (costo promedio del kilo aprovechable)", () => {
  it("divide lo pagado por los kilos de cortes con precio", () => {
    // La cosa es con carne 22/10: media de 85 kg a $824.500; 80 kg de cortes con precio + 5 kg de hueso.
    const r = carcassYield(824500, 85, [
      { weight: 80, unitPrice: 20000 },
      { weight: 5, unitPrice: 0 }
    ]);
    assert.deepEqual(r, { usableKg: 80, usablePct: 94.1, avgCostPerKg: 10306.25 });
  });

  it("sin cortes con precio o sin costo no muestra nada", () => {
    assert.equal(carcassYield(824500, 85, [{ weight: 5, unitPrice: 0 }]), null);
    assert.equal(carcassYield(0, 85, [{ weight: 80, unitPrice: 20000 }]), null);
  });
});
