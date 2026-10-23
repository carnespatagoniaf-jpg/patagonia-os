import assert from "node:assert/strict";
import { test } from "node:test";
import { carcassLosses, computePeriodResult, parsePeriodResult } from "./period-result";

const base = () =>
  parsePeriodResult({
    sales: {
      mostrador_total: 1_000_000,
      mostrador_sales: 40,
      lines: { identified_amount: 900_000, identified_cost: 560_000, missing_cost_amount: 100_000, unidentified_amount: 120_000 },
      account_total: 200_000,
      account_items_cost: 90_000,
      account_without_items: 50_000,
      turnos_total: 0
    },
    expenses: [
      { kind: "gasto", category: "servicios", amount: "60000", count: 2 },
      { kind: "gasto", category: "otro", amount: 15000, count: 3 },
      { kind: "sueldos", category: "vale_adelanto", amount: 100000, count: 5 },
      { kind: "sueldos", category: "sueldo", amount: 150000, count: 1 }
    ],
    stock_adjustments: [
      { product_id: "a", product_name: "Asado", product_code: "1", unit: "kg", lost_qty: 2, lost_value: 22400, found_qty: 0, found_value: 0, count: 1, reasons: ["Conteo"] },
      { product_id: "b", product_name: "Vacío", product_code: "2", unit: "kg", lost_qty: 0, lost_value: 0, found_qty: 1, found_value: 12800, count: 1, reasons: null }
    ],
    wastes: [
      { product_id: "a", product_name: "Asado", product_code: "1", unit: "kg", reason: "mal_estado", quantity: "1.5", value: "16800", count: 1 }
    ],
    carcass: []
  });

test("resultado: ventas − costo (con lo estimado) − faltantes − gastos − sueldos", () => {
  const r = computePeriodResult(base());
  assert.equal(r.sales, 1_200_000);
  // 560.000 de costo sobre 800.000 con costo → 70%.
  assert.equal(r.costRatio, 0.7);
  // Sin costo (100.000) + sin producto (120.000) + a cuenta sin artículos (50.000) al 70%.
  assert.equal(r.estimatedSales, 270_000);
  assert.equal(r.estimatedCost, 189_000);
  assert.equal(r.cost, 560_000 + 90_000 + 189_000);
  assert.equal(r.grossProfit, 1_200_000 - 839_000);
  assert.equal(r.stockLoss, 22400);
  assert.equal(r.stockFound, 12800);
  assert.equal(r.expenses, 75000);
  assert.equal(r.salaries, 250000);
  assert.equal(r.wasteLoss, 16800);
  assert.equal(r.result, 361_000 - 22400 - 16800 - 75000 - 250000);
  assert.equal(r.resultPct, -0.3);
  assert.deepEqual(r.expenseLines.map((e) => e.label), ["Servicios (luz, gas, alquiler)", "Otros gastos"]);
  assert.deepEqual(r.salaryLines.map((e) => e.category), ["sueldo", "vale_adelanto"]);
});

test("resultado: si nada tiene costo no se estima (y no se inventa margen)", () => {
  const d = base();
  d.sales.identifiedCost = 0;
  const r = computePeriodResult(d);
  assert.equal(r.costRatio, null);
  assert.equal(r.estimatedCost, 0);
});

test("resultado vacío", () => {
  const r = computePeriodResult(parsePeriodResult(null));
  assert.equal(r.sales, 0);
  assert.equal(r.result, 0);
  assert.equal(r.resultPct, null);
});

test("desposte: merma por res, deja afuera las sin cortes y las sospechosas de los totales", () => {
  const c = carcassLosses([
    { id: "1", date: "2026-10-16", animalType: "Media res", supplier: "Frigo", totalWeight: 120, totalCost: 840_000, cutsWeight: 105, cuts: 14 },
    { id: "2", date: "2026-10-18", animalType: "Media res", supplier: null, totalWeight: 110, totalCost: 770_000, cutsWeight: 0, cuts: 0 },
    { id: "3", date: "2026-10-19", animalType: "Cerdo", supplier: null, totalWeight: 80, totalCost: 400_000, cutsWeight: 30, cuts: 3 }
  ]);
  assert.equal(c.batches[0].lossKg, 15);
  assert.equal(c.batches[0].lossPct, 12.5);
  assert.equal(c.batches[0].lossValue, 105_000);
  assert.equal(c.batches[1].noCuts, true);
  assert.equal(c.batches[1].lossPct, null);
  assert.equal(c.batches[2].suspicious, true);
  assert.equal(c.totalWeight, 120);
  assert.equal(c.lossPct, 12.5);
  assert.equal(c.lossValue, 105_000);
});
