import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planScaleImport } from "./scale-import";
import type { EngineProduct } from "./types";

const P = (code: string, name: string): EngineProduct => ({ id: `p${code}`, code, name, unit: "unit", priceRetail: 0 });

describe("planScaleImport", () => {
  it("crea solo lo que falta, con el número de la balanza como código", () => {
    const plan = planScaleImport(
      [
        { number: 12, name: "QUESO CREMOSO ", byWeight: true, price: 9800 },
        { number: 1, name: "QUESO", byWeight: true, price: 5000 },
        { number: 30, name: "ACEITUNAS x200", byWeight: false, price: 2500.5 }
      ],
      [P("1", "queso")]
    );
    assert.equal(plan.existing, 1);
    assert.deepEqual(
      plan.rows.map((r) => [r.code, r.name, r.unit, r.price_retail]),
      [
        ["12", "QUESO CREMOSO", "kg", 9800],
        ["30", "ACEITUNAS x200", "unit", 2500.5]
      ]
    );
  });

  it("deja afuera lugares vacíos, de fábrica, de prueba y repetidos", () => {
    const plan = planScaleImport(
      [
        { number: 1, name: "NOMBRE", byWeight: false, price: 955481 },
        { number: 2, name: "   ", byWeight: true, price: 0 },
        { number: 97, name: "PRUEBA PATAGONIA", byWeight: true, price: 1 },
        { number: 5, name: "SALAME", byWeight: true, price: 0 },
        { number: 5, name: "SALAME OTRO", byWeight: true, price: 10 },
        { number: 0, name: "CERO", byWeight: true, price: 10 }
      ],
      []
    );
    assert.equal(plan.ignored, 5);
    assert.deepEqual(plan.rows.map((r) => [r.code, r.price_retail]), [["5", 0]]);
  });
});
