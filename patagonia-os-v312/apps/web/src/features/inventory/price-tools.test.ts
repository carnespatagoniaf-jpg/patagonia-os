import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPricePlan, costChangesFromPurchase, lowMarginProducts, roundPrice, roundPriceUp, validatePlanOptions, type PlanProduct, type PricePlanOptions } from "./price-tools";

const product = (over: Partial<PlanProduct> & { id: string }): PlanProduct => ({
  code: over.id,
  name: `Producto ${over.id}`,
  unit: "kg",
  cost: 10000,
  priceRetail: 15000,
  categoryId: "cat-1",
  active: true,
  ...over
});

const base: PricePlanOptions = { mode: "percent", percent: 10, targetMargin: 30, rounding: 0, alsoCost: false, categoryId: "" };

describe("redondeo", () => {
  it("al múltiplo más cercano", () => {
    assert.equal(roundPrice(16544, 100), 16500);
    assert.equal(roundPrice(16550, 100), 16600);
    assert.equal(roundPrice(16523, 50), 16500);
    assert.equal(roundPrice(16523.456, 0), 16523.46);
  });

  it("hacia arriba (para no quedar bajo el margen buscado)", () => {
    assert.equal(roundPriceUp(16501, 100), 16600);
    assert.equal(roundPriceUp(16500, 100), 16500);
    assert.equal(roundPriceUp(13000.001, 0), 13000.01);
  });
});

describe("validatePlanOptions", () => {
  it("rechaza porcentajes vacíos, cero o fuera de rango", () => {
    assert.ok(validatePlanOptions({ ...base, percent: NaN }));
    assert.ok(validatePlanOptions({ ...base, percent: 0 }));
    assert.ok(validatePlanOptions({ ...base, percent: -100 }));
    assert.ok(validatePlanOptions({ ...base, percent: 501 }));
    assert.equal(validatePlanOptions({ ...base, percent: -5 }), null);
  });

  it("valida el margen mínimo", () => {
    assert.ok(validatePlanOptions({ ...base, mode: "margin", targetMargin: -1 }));
    assert.equal(validatePlanOptions({ ...base, mode: "margin", targetMargin: 30 }), null);
  });
});

describe("buildPricePlan — subir/bajar un porcentaje", () => {
  it("sube 10% el precio y no toca el costo por defecto", () => {
    const [row] = buildPricePlan([product({ id: "a" })], base);
    assert.equal(row.newPrice, 16500);
    assert.equal(row.newCost, 10000);
    assert.equal(row.oldMargin, 50);
    assert.equal(row.newMargin, 65);
  });

  it("puede subir también el costo", () => {
    const [row] = buildPricePlan([product({ id: "a" })], { ...base, alsoCost: true });
    assert.equal(row.newCost, 11000);
    assert.equal(row.newMargin, 50);
  });

  it("baja precios con porcentaje negativo", () => {
    const [row] = buildPricePlan([product({ id: "a", priceRetail: 20000 })], { ...base, percent: -5 });
    assert.equal(row.newPrice, 19000);
  });

  it("aplica el redondeo pedido", () => {
    const [row] = buildPricePlan([product({ id: "a", priceRetail: 15990 })], { ...base, percent: 7, rounding: 100 });
    assert.equal(row.newPrice, 17100); // 17109,3 -> 17100
  });

  it("filtra por categoría, ignora inactivos y no toca productos sin precio", () => {
    const rows = buildPricePlan(
      [
        product({ id: "a", categoryId: "cat-1" }),
        product({ id: "b", categoryId: "cat-2" }),
        product({ id: "c", categoryId: "cat-1", active: false }),
        product({ id: "d", categoryId: "cat-1", priceRetail: 0 })
      ],
      { ...base, categoryId: "cat-1" }
    );
    assert.deepEqual(rows.map((r) => r.id), ["a"]);
  });

  it("con opciones inválidas no propone nada", () => {
    assert.deepEqual(buildPricePlan([product({ id: "a" })], { ...base, percent: 0 }), []);
  });
});

describe("buildPricePlan — llevar al margen mínimo", () => {
  const margin: PricePlanOptions = { ...base, mode: "margin", targetMargin: 30 };

  it("solo sube los que están por debajo del margen buscado", () => {
    const rows = buildPricePlan(
      [
        product({ id: "bajo", cost: 10000, priceRetail: 11000 }), // 10% -> sube a 13000
        product({ id: "justo", cost: 10000, priceRetail: 13000 }),
        product({ id: "alto", cost: 10000, priceRetail: 20000 })
      ],
      margin
    );
    assert.deepEqual(rows.map((r) => [r.id, r.newPrice, r.newMargin]), [["bajo", 13000, 30]]);
  });

  it("nunca baja un precio y salta productos sin costo", () => {
    const rows = buildPricePlan([product({ id: "sin-costo", cost: 0, priceRetail: 500 }), product({ id: "alto", priceRetail: 99999 })], margin);
    assert.deepEqual(rows, []);
  });

  it("al redondear hacia arriba nunca queda debajo del margen", () => {
    const [row] = buildPricePlan([product({ id: "a", cost: 10333, priceRetail: 10400 })], { ...margin, rounding: 100 });
    assert.equal(row.newPrice, 13500); // 13432,9 -> 13500
    assert.ok(row.newMargin >= 30);
  });
});

describe("lowMarginProducts", () => {
  it("detecta los de margen bajo y saltea sin costo o inactivos", () => {
    const list = lowMarginProducts([
      product({ id: "bajo", cost: 10000, priceRetail: 11000 }),
      product({ id: "ok", cost: 10000, priceRetail: 15000 }),
      product({ id: "sin-costo", cost: 0, priceRetail: 1000 }),
      product({ id: "inactivo", cost: 10000, priceRetail: 10100, active: false })
    ]);
    assert.deepEqual(list.map((p) => p.id), ["bajo"]);
  });
});

describe("costChangesFromPurchase", () => {
  const catalog = [product({ id: "a", cost: 10000, priceRetail: 15000 }), product({ id: "u", unit: "unit", cost: 500, priceRetail: 800 })];

  it("propone el costo de la compra y calcula el margen resultante", () => {
    const [change] = costChangesFromPurchase(catalog, [{ productId: "a", unit: "kg", unitPrice: 12000 }]);
    assert.equal(change.newCost, 12000);
    assert.equal(change.oldCost, 10000);
    assert.equal(change.newMargin, 25);
  });

  it("ignora ítems libres, unidades distintas, precio cero o igual al costo", () => {
    const changes = costChangesFromPurchase(catalog, [
      { unit: "kg", unitPrice: 999 },
      { productId: "a", unit: "unit", unitPrice: 12000 },
      { productId: "a", unit: "kg", unitPrice: 0 },
      { productId: "u", unit: "unit", unitPrice: 500 },
      { productId: "no-existe", unit: "kg", unitPrice: 1 }
    ]);
    assert.deepEqual(changes, []);
  });

  it("si el producto aparece dos veces vale el último precio", () => {
    const [change] = costChangesFromPurchase(catalog, [
      { productId: "a", unit: "kg", unitPrice: 11000 },
      { productId: "a", unit: "kg", unitPrice: 13000 }
    ]);
    assert.equal(change.newCost, 13000);
  });
});
