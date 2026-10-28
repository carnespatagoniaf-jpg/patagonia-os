import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeList, productPrice, ruleLabel, rulePrice, scaleAmountForList } from "./price-lists";

describe("regla de la lista", () => {
  it("minorista −10%: 8.100 → 7.290 (igual que la base de datos)", () => {
    assert.equal(rulePrice({ base: "retail", pct: -10 }, 6000, 8100), 7290);
  });
  it("costo + 20%: 6.000 → 7.200", () => {
    assert.equal(rulePrice({ base: "cost", pct: 20 }, 6000, 8100), 7200);
  });
  it("sobre el costo sin costo cargado: minorista", () => {
    assert.equal(rulePrice({ base: "cost", pct: 20 }, 0, 8100), 8100);
  });
  it("redondea a pesos enteros", () => {
    assert.equal(rulePrice({ base: "retail", pct: -7 }, 0, 4199), 3905);
  });
  it("las presentaciones (ofertas, x 2 kg) van a minorista", () => {
    assert.equal(rulePrice({ base: "retail", pct: -10 }, 5000, 7000, true), 7000);
  });
  it("texto de la regla", () => {
    assert.equal(ruleLabel({ base: "retail", pct: -10 }), "minorista − 10%");
    assert.equal(ruleLabel({ base: "cost", pct: 20 }), "costo + 20%");
    assert.equal(ruleLabel({ base: "retail", pct: 0 }), "igual al minorista");
  });
});

describe("precio del producto", () => {
  const chorizo = { priceRetail: 8100, listPrices: { may: { price: 7290, manual: false } } };
  it("sin lista: minorista", () => assert.equal(productPrice(chorizo, null), 8100));
  it("con lista: el de la lista", () => assert.equal(productPrice(chorizo, "may"), 7290));
  it("lista que el producto no tiene: minorista", () => assert.equal(productPrice({ priceRetail: 4200 }, "may"), 4200));
});

describe("etiqueta de balanza con importe", () => {
  it("10.125 a minorista → 9.112,50 a mayorista (igual que la base de datos)", () => {
    assert.equal(scaleAmountForList(10125, 8100, 7290), 9112.5);
  });
  it("sin diferencia de precio no cambia", () => {
    assert.equal(scaleAmountForList(10125, 8100, 8100), 10125);
  });
});

describe("lista activa", () => {
  const lists = [
    { id: "a", name: "Mayorista", base: "retail" as const, pct: -10, active: true },
    { id: "b", name: "Vieja", base: "retail" as const, pct: -5, active: false }
  ];
  it("encuentra la activa", () => assert.equal(activeList(lists, "a")?.name, "Mayorista"));
  it("ignora la desactivada", () => assert.equal(activeList(lists, "b"), undefined));
});
