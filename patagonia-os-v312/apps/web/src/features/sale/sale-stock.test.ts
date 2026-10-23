import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { applySoldToStock } from "./sale-stock";

function product(id: string, stock: number, over: Partial<Product> = {}): Product {
  return { id, code: id, name: id, unit: "kg", cost: 0, priceRetail: 0, stock, minStock: 0, ...over };
}

describe("applySoldToStock", () => {
  it("descuenta lo vendido de cada producto", () => {
    const next = applySoldToStock([product("asado", 10), product("vacio", 5)], [{ productId: "asado", quantity: 1.25 }]);
    assert.equal(next[0].stock, 8.75);
    assert.equal(next[1].stock, 5);
  });

  it("suma dos líneas del mismo producto (una pesada y otra de la balanza)", () => {
    const next = applySoldToStock([product("asado", 10)], [{ productId: "asado", quantity: 1 }, { productId: "asado", quantity: 0.5 }]);
    assert.equal(next[0].stock, 8.5);
  });

  it("una presentación descuenta del principal × factor y recalcula todas las presentaciones", () => {
    const list = [
      product("pollo", 300),
      product("cajon15", 20, { unit: "box", stockSourceId: "pollo", stockFactor: 15 }),
      product("oferta3", 100, { stockSourceId: "pollo", stockFactor: 3 })
    ];
    const next = applySoldToStock(list, [{ productId: "cajon15", quantity: 2 }]);
    assert.equal(next[0].stock, 270);
    assert.equal(next[1].stock, 18);
    assert.equal(next[2].stock, 90);
  });

  it("redondea a 3 decimales como la vista", () => {
    const list = [product("pollo", 10), product("oferta3", 3.333, { stockSourceId: "pollo", stockFactor: 3 })];
    const next = applySoldToStock(list, [{ productId: "pollo", quantity: 0.1 }]);
    assert.equal(next[0].stock, 9.9);
    assert.equal(next[1].stock, 3.3);
  });

  it("ignora líneas manuales y productos que no están en la lista", () => {
    const list = [product("asado", 10)];
    const next = applySoldToStock(list, [{ quantity: 2 }, { productId: "otro", quantity: 1 }]);
    assert.equal(next, list);
  });

  it("no corta en cero", () => {
    const next = applySoldToStock([product("asado", 0.5)], [{ productId: "asado", quantity: 1 }]);
    assert.equal(next[0].stock, -0.5);
  });
});
