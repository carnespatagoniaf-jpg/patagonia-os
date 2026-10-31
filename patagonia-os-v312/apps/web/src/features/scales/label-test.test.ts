import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { DEFAULT_SCALE_CONFIG } from "../sale/scale-barcode";
import { labelTestResult } from "./label-test";

const product = (code: string, name: string, unit: "kg" | "unit", priceRetail: number) =>
  ({ id: `id-${code}`, code, name, unit, priceRetail, active: true }) as unknown as Product;

function withCheck(first12: string): string {
  const d = first12.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
}

const products = [product("12", "Vacío", "kg", 10000), product("7790001", "Coca 1,5 L", "unit", 2500)];
const M2 = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" as const };

describe("Probá una etiqueta (Mi balanza)", () => {
  it("una etiqueta bien leída dice producto, kilos e importe", () => {
    const r = labelTestResult(withCheck("200012012500"), { products, config: DEFAULT_SCALE_CONFIG });
    assert.equal(r?.ok, true);
    assert.match(r!.detail, /Vacío: 1,250 kg · \$12\.500/);
  });

  it("con importe (M2, 2-3-7) cobra lo impreso", () => {
    const r = labelTestResult("2000258567506", { products: [product("2", "Matambre", "kg", 13700)], config: M2 });
    assert.equal(r?.ok, true);
    assert.match(r!.detail, /Matambre: 4,275 kg · \$58\.567,5/);
  });

  it("el código de un producto no es una etiqueta", () => {
    const r = labelTestResult("7790001", { products, config: DEFAULT_SCALE_CONFIG });
    assert.equal(r?.ok, false);
    assert.match(r!.title, /código de un producto/);
  });

  it("etiqueta de un producto que no existe en Patagonia: dice el número", () => {
    const r = labelTestResult(withCheck("200099012500"), { products, config: DEFAULT_SCALE_CONFIG });
    assert.equal(r?.ok, false);
    assert.match(r!.detail, /N\.º 99/);
  });

  it("kilos imposibles: avisa que el formato no es el de la sucursal", () => {
    const r = labelTestResult(withCheck("200012999340"), { products, config: DEFAULT_SCALE_CONFIG });
    assert.equal(r?.ok, false);
    assert.match(r!.title, /demasiados kilos/);
  });

  it("parece etiqueta pero con otro largo", () => {
    const r = labelTestResult("200001201250", { products, config: DEFAULT_SCALE_CONFIG });
    assert.equal(r?.ok, false);
    assert.match(r!.title, /formato de esta sucursal/);
  });

  it("vacío no dice nada", () => {
    assert.equal(labelTestResult("  ", { products, config: DEFAULT_SCALE_CONFIG }), null);
  });
});
