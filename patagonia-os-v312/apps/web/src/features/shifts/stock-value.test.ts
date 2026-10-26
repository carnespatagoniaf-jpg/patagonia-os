import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { stockValueReport } from "./stock-value";

const P = (over: Partial<Product>): Product => ({ id: Math.random().toString(), code: "1", name: "X", unit: "kg", cost: 0, priceRetail: 0, stock: 0, minStock: 0, ...over });

describe("Stock valorizado", () => {
  const categories = [{ id: "vac", name: "Vacuno" }, { id: "alm", name: "Almacén" }];
  const r = stockValueReport(
    [
      P({ name: "Vacío", categoryId: "vac", stock: 10.5, cost: 13000, priceRetail: 15500 }),
      P({ name: "Matambre", categoryId: "vac", stock: -4.275, cost: 9700, priceRetail: 13700 }),
      P({ name: "Aceite", categoryId: "alm", unit: "unit", stock: 100, cost: 2000, priceRetail: 2400 }),
      P({ name: "Oferta aceite x3", categoryId: "alm", unit: "unit", stock: 33, cost: 6000, priceRetail: 6500, stockSourceId: "aceite" }),
      P({ name: "Sal", stock: 5, cost: 0, priceRetail: 800 }),
      P({ name: "Sin stock", categoryId: "vac", stock: 0, cost: 5000, priceRetail: 7000 })
    ],
    categories
  );

  it("valoriza a costo y a precio de venta, por categoría, de la que más vale a la que menos", () => {
    assert.deepEqual(r.categories.map((c) => [c.name, c.costValue, c.saleValue]), [
      ["Almacén", 200000, 240000],
      ["Vacuno", 136500, 162750],
      ["Sin categoría", 0, 4000]
    ]);
    assert.equal(r.costValue, 336500);
    assert.equal(r.saleValue, 406750);
    assert.equal(r.profit, 70250);
    assert.equal(r.productsWithStock, 3);
  });

  it("no cuenta las presentaciones ni lo que está en 0; lo negativo va aparte y lo sin costo se marca", () => {
    assert.ok(!r.categories.some((c) => c.rows.some((x) => x.name === "Oferta aceite x3" || x.name === "Sin stock")));
    assert.deepEqual(r.negative.map((x) => x.name), ["Matambre"]);
    assert.equal(r.noCostCount, 1);
    assert.equal(r.categories.find((c) => c.name === "Sin categoría")?.rows[0].noCost, true);
  });
});
