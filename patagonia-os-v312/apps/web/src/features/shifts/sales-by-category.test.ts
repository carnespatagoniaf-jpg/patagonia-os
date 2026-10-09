import assert from "node:assert/strict";
import { test } from "node:test";
import { changePct, groupSalesByCategory, marginOnCost, previousPeriod, type ProductSalesRow } from "./sales-by-category";

const row = (over: Partial<ProductSalesRow>): ProductSalesRow => ({
  productId: "p", productName: "X", productCode: "1", unit: "kg", categoryId: "c", categoryName: "C",
  quantity: 1, amount: 100, lines: 1, cost: 0, estimatedCostLines: 0, missingCostLines: 0, ...over
});

test("agrupa por categoría, suma plata, kilos y ganancia, y deja 'Sin producto' al final", () => {
  const r = groupSalesByCategory([
    row({ productId: "asado", productName: "Asado", categoryId: "carne", categoryName: "Carne", quantity: 10.5, amount: 150000, cost: 100000 }),
    row({ productId: "vacio", productName: "Vacío", categoryId: "carne", categoryName: "Carne", quantity: 4, amount: 64000, cost: 44000, estimatedCostLines: 2 }),
    row({ productId: "pata", productName: "Pata muslo", categoryId: "pollo", categoryName: "Pollo", quantity: 8.25, amount: 41250, cost: 28050 }),
    row({ productId: "huevos", productName: "Maple de huevos", categoryId: "almacen", categoryName: "Almacén", unit: "unit", quantity: 3, amount: 15000, cost: 0, missingCostLines: 1 }),
    row({ productId: null, productName: "Tickets de total de la balanza", productCode: null, unit: null, categoryId: null, categoryName: null, quantity: 4, amount: 300000 }),
    row({ productId: "x", productName: "Sin cat", categoryId: null, categoryName: null, quantity: 1, amount: 5000, cost: 2500 })
  ]);
  assert.equal(r.total, 575250);
  assert.deepEqual(r.categories.map((c) => c.name), ["Carne", "Pollo", "Almacén", "Sin categoría", "Sin producto"]);
  const carne = r.categories[0];
  assert.equal(carne.amount, 214000);
  assert.equal(carne.kg, 14.5);
  assert.equal(carne.pct, 37.2);
  assert.equal(carne.profit, 70000);
  assert.equal(carne.marginPct, 48.6, "70.000 sobre 144.000");
  assert.deepEqual(carne.products.map((p) => p.productName), ["Asado", "Vacío"]);
  assert.equal(r.categories[1].marginPct, 47.1, "pollo: 41.250 sobre 28.050");
  assert.equal(r.categories[2].units, 3, "los productos por unidad no suman kilos");
  assert.equal(r.categories[2].marginPct, null, "sin costo no hay margen");
  const sinProducto = r.categories[4];
  assert.equal(sinProducto.unidentified, true);
  assert.equal(sinProducto.profit, null, "no se sabe qué costó");
  assert.equal(r.profit, 70000 + 13200 + 15000 + 2500);
  assert.equal(r.estimatedCostLines, 2);
  assert.deepEqual(r.missingCostProducts, ["Maple de huevos"]);
});

test("sin ventas", () => {
  const r = groupSalesByCategory([]);
  assert.equal(r.total, 0);
  assert.deepEqual(r.categories, []);
});

test("margen sobre el costo, igual que en Stock", () => {
  assert.equal(marginOnCost(15000, 10000), 50);
  assert.equal(marginOnCost(15000, 0), null);
});

test("comparación con el período anterior", () => {
  assert.equal(changePct(118, 100), 18);
  assert.equal(changePct(91, 100), -9);
  assert.equal(changePct(50, 0), null, "antes no se vendió: no hay %");
  assert.deepEqual(previousPeriod("2026-10-08", "2026-10-14"), { from: "2026-10-01", to: "2026-10-07" });
  assert.deepEqual(previousPeriod("2026-10-08", "2026-10-08"), { from: "2026-10-07", to: "2026-10-07" });
  assert.deepEqual(previousPeriod("2026-03-01", "2026-03-31"), { from: "2026-01-29", to: "2026-02-28" });
});
