import test from "node:test";
import assert from "node:assert/strict";
import { assertSellable, cartTotal, estimatedProfit, purchaseTotal, Product } from "./index.js";

const nalga: Product = {
  id: "1",
  code: "VAC-001",
  name: "Nalga",
  unit: "kg",
  cost: 15000,
  priceRetail: 21700,
  stock: 10,
  minStock: 3
};

test("calcula total de carrito", () => {
  assert.equal(cartTotal([{ product: nalga, quantity: 2, unitPrice: 21700 }]), 43400);
});

test("calcula ganancia estimada", () => {
  assert.equal(estimatedProfit([{ product: nalga, quantity: 2, unitPrice: 21700 }]), 13400);
});

test("impide vender más stock del disponible", () => {
  assert.throws(() => assertSellable({ product: nalga, quantity: 11, unitPrice: 21700 }));
});

test("calcula total de compra por líneas", () => {
  assert.equal(
    purchaseTotal([
      { quantity: 3, unitPrice: 10000 },
      { quantity: 2, unitPrice: 20000 }
    ]),
    70000
  );
});
