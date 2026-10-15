import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSellable,
  cartTotal,
  carcassCutLineTotal,
  allocateCarcassCost,
  estimatedProfit,
  marginPercent,
  priceFromMargin,
  recipeCost,
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

test("allocateCarcassCost: la compra se reparte por lo que vale cada corte", () => {
  // Media res de 100 kg a $5.000/kg = $500.000. Lomo 5 kg a $20.000, asado 20 kg a $10.000, carne picada 30 kg a
  // $6.000, hueso 10 kg sin precio. Valor total = 100.000 + 200.000 + 180.000 = 480.000.
  const lines = allocateCarcassCost(500000, [
    { productId: "lomo", weight: 5, unitPrice: 20000 },
    { productId: "asado", weight: 20, unitPrice: 10000 },
    { productId: "picada", weight: 30, unitPrice: 6000 },
    { productId: null, weight: 10, unitPrice: 0 }
  ]);
  assert.deepEqual(lines.map((l) => [l.productId, l.cost, l.costPerKg]), [
    ["lomo", 104166.67, 20833.33],
    ["asado", 208333.33, 10416.67],
    ["picada", 187500, 6250]
  ]);
  // Todo el costo queda en lo que se vende (el hueso no carga costo).
  assert.equal(Math.round(lines.reduce((s, l) => s + l.cost, 0)), 500000);
});

test("allocateCarcassCost: el mismo producto en dos cortes se suma; sin precios se reparte por kilos", () => {
  const lines = allocateCarcassCost(120000, [
    { productId: "pollo", weight: 10, unitPrice: 0 },
    { productId: "pollo", weight: 10, unitPrice: 0 },
    { productId: "menudo", weight: 4, unitPrice: 0 }
  ]);
  assert.deepEqual(lines.map((l) => [l.productId, l.weight, l.cost, l.costPerKg]), [
    ["pollo", 20, 100000, 5000],
    ["menudo", 4, 20000, 5000]
  ]);
  assert.deepEqual(allocateCarcassCost(1000, []), []);
});

test("recipeCost: milanesas con merma de limpieza en la nalga", () => {
  const result = recipeCost({
    ingredients: [
      { quantity: 10, wastePct: 8, unitCost: 15000 }, // nalga: hay que comprar 10 / 0,92 = 10,8696 kg
      { quantity: 20, wastePct: 0, unitCost: 300 }, // huevos
      { quantity: 2, wastePct: 0, unitCost: 2000 } // pan rallado
    ],
    extraCost: 5000,
    yieldQty: 10,
    marginPct: 45
  });
  assert.equal(result.lines[0].cost, 163043.48);
  assert.equal(Math.round(result.lines[0].grossQuantity * 10000) / 10000, 10.8696);
  assert.equal(result.batchCost, 178043.48);
  assert.equal(result.unitCost, 17804.35);
  assert.equal(result.suggestedPrice, 25816.31);
});

test("recipeCost: hamburguesas sin merma, el rinde es la suma de los kilos", () => {
  const result = recipeCost({
    ingredients: [
      { quantity: 1, wastePct: 0, unitCost: 10000 },
      { quantity: 0.3, wastePct: 0, unitCost: 4000 }
    ],
    extraCost: 0,
    yieldQty: 1.3,
    marginPct: 60
  });
  assert.equal(result.batchCost, 11200);
  assert.equal(result.unitCost, 8615.38);
  assert.equal(result.suggestedPrice, 13784.61);
});

test("recipeCost: sin rinde válido no da costo ni precio, y sin margen no sugiere precio", () => {
  const sinRinde = recipeCost({ ingredients: [{ quantity: 1, wastePct: 0, unitCost: 100 }], extraCost: 0, yieldQty: 0, marginPct: 30 });
  assert.equal(sinRinde.unitCost, 0);
  assert.equal(sinRinde.suggestedPrice, null);
  const sinMargen = recipeCost({ ingredients: [{ quantity: 1, wastePct: 0, unitCost: 100 }], extraCost: 0, yieldQty: 2 });
  assert.equal(sinMargen.unitCost, 50);
  assert.equal(sinMargen.suggestedPrice, null);
});

test("recipeCost: una merma del 100% no rompe el cálculo", () => {
  const result = recipeCost({ ingredients: [{ quantity: 1, wastePct: 100, unitCost: 100 }], extraCost: 10, yieldQty: 1 });
  assert.equal(result.lines[0].grossQuantity, 0);
  assert.equal(result.batchCost, 10);
});
