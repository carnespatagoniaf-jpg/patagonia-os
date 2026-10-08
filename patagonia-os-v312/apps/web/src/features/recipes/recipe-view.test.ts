import assert from "node:assert/strict";
import { test } from "node:test";
import type { Product } from "@patagonia/domain";
import { checkPrice, comboDiscountPct, comboRetailTotal, suggestedYieldKg, summarizeRecipe } from "./recipe-view";
import type { Recipe } from "./recipes-service";

function product(id: string, name: string, unit: Product["unit"], cost: number): Product {
  return { id, code: id, name, unit, cost, priceRetail: 0, stock: 0, minStock: 0 };
}

const productos = new Map<string, Product>(
  [
    product("nalga", "Nalga", "kg", 15000),
    product("huevo", "Huevo", "unit", 300),
    product("pan", "Pan rallado", "kg", 2000),
    product("mila", "Milanesa", "kg", 17804.35),
    product("sin-costo", "Perejil", "kg", 0)
  ].map((p) => [p.id, p])
);

const milanesas: Recipe = {
  id: "r1",
  productId: "mila",
  yieldQty: 10,
  extraCost: 5000,
  marginPct: 45,
  notes: "",
  updatedAt: "2026-09-28T00:00:00Z",
  items: [
    { ingredientProductId: "nalga", quantity: 10, wastePct: 8 },
    { ingredientProductId: "huevo", quantity: 20, wastePct: 0 },
    { ingredientProductId: "pan", quantity: 2, wastePct: 0 }
  ]
};

test("una receta cuyo producto ya tiene el costo que da hoy está al día", () => {
  const summary = summarizeRecipe(milanesas, productos);
  assert.equal(summary.cost.unitCost, 17804.35);
  assert.equal(summary.loadedCost, 17804.35);
  assert.equal(summary.drift, false);
  assert.equal(summary.missingIngredients, 0);
  assert.deepEqual(summary.zeroCostIngredients, []);
});

test("si sube la carne, la receta queda desactualizada", () => {
  const masCara = new Map(productos);
  masCara.set("nalga", product("nalga", "Nalga", "kg", 18000));
  const summary = summarizeRecipe(milanesas, masCara);
  assert.equal(summary.cost.unitCost, 21065.22);
  assert.equal(summary.drift, true);
});

test("avisa los insumos sin costo y los que ya no existen", () => {
  const conProblemas: Recipe = {
    ...milanesas,
    items: [...milanesas.items, { ingredientProductId: "sin-costo", quantity: 0.1, wastePct: 0 }, { ingredientProductId: "borrado", quantity: 1, wastePct: 0 }]
  };
  const summary = summarizeRecipe(conProblemas, productos);
  assert.deepEqual(summary.zeroCostIngredients, ["Perejil"]);
  assert.equal(summary.missingIngredients, 1);
});

test("sin rinde válido no se marca desactualizada (no hay costo que comparar)", () => {
  const summary = summarizeRecipe({ ...milanesas, yieldQty: 0 }, productos);
  assert.equal(summary.cost.unitCost, 0);
  assert.equal(summary.drift, false);
});

test("suggestedYieldKg suma solo los kilos netos de insumos medidos en kg", () => {
  const kg = suggestedYieldKg(
    [
      { ingredientProductId: "nalga", quantity: 10 },
      { ingredientProductId: "huevo", quantity: 20 }, // unidades: no suman
      { ingredientProductId: "pan", quantity: 2.25 }
    ],
    productos
  );
  assert.equal(kg, 12.25);
});

import { formatCost, parseRecipeDraft, type RecipeDraft } from "./recipe-view";

const borrador: RecipeDraft = {
  productId: "mila",
  yieldQty: "10",
  extraCost: "5.000",
  marginPct: "45",
  notes: "  con perejil ",
  items: [
    { ingredientProductId: "nalga", quantity: "10", wastePct: "8" },
    { ingredientProductId: "huevo", quantity: "20", wastePct: "" }
  ]
};

test("parseRecipeDraft convierte lo escrito: el costo extra usa formato argentino, el resto números comunes", () => {
  const parsed = parseRecipeDraft(borrador);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.input.extraCost, 5000);
    assert.equal(parsed.input.yieldQty, 10);
    assert.equal(parsed.input.marginPct, 45);
    assert.equal(parsed.input.notes, "con perejil");
    assert.deepEqual(parsed.input.items[1], { ingredientProductId: "huevo", quantity: 20, wastePct: 0 });
  }
});

test("parseRecipeDraft: margen vacío es 'sin margen' y costo extra vacío es cero", () => {
  const parsed = parseRecipeDraft({ ...borrador, marginPct: "", extraCost: "" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.input.marginPct, null);
    assert.equal(parsed.input.extraCost, 0);
  }
});

test("parseRecipeDraft rechaza lo que no sirve, con un mensaje claro", () => {
  const error = (draft: RecipeDraft) => {
    const parsed = parseRecipeDraft(draft);
    return parsed.ok ? "OK" : parsed.error;
  };
  assert.match(error({ ...borrador, productId: "" }), /producto terminado/);
  assert.match(error({ ...borrador, yieldQty: "0" }), /rinde/);
  assert.match(error({ ...borrador, items: [] }), /al menos un insumo/);
  assert.match(error({ ...borrador, items: [{ ingredientProductId: "a", quantity: "0", wastePct: "0" }] }), /insumo 1/);
  assert.match(error({ ...borrador, items: [{ ingredientProductId: "a", quantity: "1", wastePct: "100" }] }), /merma del insumo 1/);
  assert.match(error({ ...borrador, extraCost: "abc" }), /costo extra/);
  assert.match(error({ ...borrador, marginPct: "-5" }), /margen/);
});

test("formatCost muestra centavos", () => {
  assert.match(formatCost(17804.35), /17\.804,35/);
});

test("combo: costo como receta sin merma que rinde 1, y cuánto saldría suelto", () => {
  const conPrecio = new Map<string, Product>(
    [
      { ...product("mila-pollo", "Milanesa de pollo", "kg", 7800), priceRetail: 11800 },
      { ...product("pata", "Pata muslo", "kg", 3400), priceRetail: 5200 },
      { ...product("hamb", "Hamburguesas x4", "unit", 3900), priceRetail: 6200 },
      { ...product("combo", "Combo familiar", "unit", 0), priceRetail: 0 }
    ].map((p) => [p.id, p])
  );
  const combo: Recipe = {
    id: "c1",
    kind: "combo",
    productId: "combo",
    yieldQty: 1,
    extraCost: 300,
    marginPct: 30,
    notes: "",
    updatedAt: "2026-10-08T00:00:00Z",
    items: [
      { ingredientProductId: "mila-pollo", quantity: 1, wastePct: 0 },
      { ingredientProductId: "pata", quantity: 1, wastePct: 0 },
      { ingredientProductId: "hamb", quantity: 2, wastePct: 0 }
    ]
  };
  const summary = summarizeRecipe(combo, conPrecio);
  // 7.800 + 3.400 + 2 × 3.900 + 300 de bolsa = 19.300
  assert.equal(summary.cost.unitCost, 19300);
  assert.equal(summary.cost.suggestedPrice, 25090);
  // Suelto: 11.800 + 5.200 + 2 × 6.200 = 29.400
  const suelto = comboRetailTotal(combo.items, conPrecio);
  assert.equal(suelto, 29400);
  // Vendido a 25.090: 14,7 % más barato que suelto.
  assert.equal(comboDiscountPct(25090, suelto), 14.7);
  assert.equal(comboDiscountPct(0, suelto), null);
  assert.equal(comboDiscountPct(1000, 0), null);
});

test("probar un precio: cuánto se gana en plata y en %, y el descuento del combo", () => {
  // Combo que cuesta $19.300 y suelto saldría $29.400, vendido a $25.000.
  assert.deepEqual(checkPrice(25000, 19300, 29400), { profit: 5700, marginPct: 29.5, discountPct: 15 });
  // Receta (sin precio suelto): milanesa que cuesta $17.804,35 a $26.000.
  assert.deepEqual(checkPrice(26000, 17804.35), { profit: 8195.65, marginPct: 46, discountPct: null });
  // Por debajo del costo: pérdida y margen negativo.
  assert.deepEqual(checkPrice(15000, 19300, 29400), { profit: -4300, marginPct: -22.3, discountPct: 49 });
  assert.equal(checkPrice(0, 19300), null);
  // Sin costo cargado no hay %.
  assert.equal(checkPrice(1000, 0)?.marginPct, null);
});
