import assert from "node:assert/strict";
import { test } from "node:test";
import { groupSalesByCategory, type ProductSalesRow } from "./sales-by-category";

const row = (over: Partial<ProductSalesRow>): ProductSalesRow => ({
  productId: "p", productName: "X", productCode: "1", unit: "kg", categoryId: "c", categoryName: "C", quantity: 1, amount: 100, lines: 1, ...over
});

test("agrupa por categoría, suma plata y kilos, y deja 'Sin producto' al final", () => {
  const { total, categories } = groupSalesByCategory([
    row({ productId: "asado", productName: "Asado", categoryId: "carne", categoryName: "Carne", quantity: 10.5, amount: 150000 }),
    row({ productId: "vacio", productName: "Vacío", categoryId: "carne", categoryName: "Carne", quantity: 4, amount: 64000 }),
    row({ productId: "pata", productName: "Pata muslo", categoryId: "pollo", categoryName: "Pollo", quantity: 8.25, amount: 41250 }),
    row({ productId: "huevos", productName: "Maple de huevos", categoryId: "almacen", categoryName: "Almacén", unit: "unit", quantity: 3, amount: 15000 }),
    row({ productId: null, productName: "Tickets de total de la balanza", productCode: null, unit: null, categoryId: null, categoryName: null, quantity: 4, amount: 300000 }),
    row({ productId: "x", productName: "Sin cat", categoryId: null, categoryName: null, quantity: 1, amount: 5000 })
  ]);
  assert.equal(total, 575250);
  assert.deepEqual(categories.map((c) => c.name), ["Carne", "Pollo", "Almacén", "Sin categoría", "Sin producto"]);
  const carne = categories[0];
  assert.equal(carne.amount, 214000);
  assert.equal(carne.kg, 14.5);
  assert.equal(carne.pct, 37.2);
  assert.deepEqual(carne.products.map((p) => p.productName), ["Asado", "Vacío"]);
  assert.equal(categories[2].units, 3, "los productos por unidad no suman kilos");
  assert.equal(categories[2].kg, 0);
  const sinProducto = categories[4];
  assert.equal(sinProducto.unidentified, true);
  assert.equal(sinProducto.pct, 52.2, "aunque sea lo más grande, va al final");
});

test("sin ventas", () => {
  assert.deepEqual(groupSalesByCategory([]), { total: 0, categories: [] });
});
