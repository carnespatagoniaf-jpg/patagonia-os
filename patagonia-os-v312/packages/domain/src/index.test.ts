import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSellable,
  cartTotal,
  carcassCutLineTotal,
  estimatedProfit,
  marginPercent,
  priceFromMargin,
  purchaseTotal,
  Product
} from "./index.js";

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

test("calcula precio de venta a partir de costo y margen", () => {
  // Chinchulín: costo $4.500, margen 60% -> venta $7.200 (planilla real de costos)
  assert.equal(priceFromMargin(4500, 60), 7200);
});

test("calcula margen a partir de costo y venta", () => {
  assert.equal(marginPercent(4500, 7200), 60);
});

test("priceFromMargin y marginPercent son inversas", () => {
  const venta = priceFromMargin(15000, 45);
  assert.equal(marginPercent(15000, venta), 45);
});

test("margen es 0 cuando el costo es 0 (evita división por cero)", () => {
  assert.equal(marginPercent(0, 5000), 0);
});

test("calcula el subtotal de un corte por peso x precio", () => {
  // Asado de la media 119: 8.61kg a $16.000/kg -> $137.760 (planilla real de despiece)
  assert.equal(carcassCutLineTotal({ weight: 8.61, unitPrice: 16000 }), 137760);
});
