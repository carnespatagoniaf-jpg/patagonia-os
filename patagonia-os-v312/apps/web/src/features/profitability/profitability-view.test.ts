import { test } from "node:test";
import assert from "node:assert/strict";
import { changePct, profitView } from "./profitability-view";

test("resta gastos, sueldos, mermas y costos fijos", () => {
  const v = profitView({ sales: 1_000_000, grossProfit: 300_000, losses: 10_000, expenses: 50_000, salaries: 100_000, fixedPeriod: 40_000, fixedMonthly: 40_000, days: 30 });
  assert.equal(v.net, 100_000);
  assert.equal(v.netPct, 10);
  assert.equal(v.grossPct, 30);
  // Por mes se van 40.000 + 160.000 = 200.000; con 30% de margen hay que vender 666.667.
  assert.equal(v.breakEvenMonthly, 666_667);
  assert.equal(v.breakEvenDaily, 22_222);
});

test("sin ventas o sin margen no hay punto de equilibrio", () => {
  assert.equal(profitView({ sales: 0, grossProfit: 0, losses: 0, expenses: 0, salaries: 0, fixedPeriod: 0, fixedMonthly: 100, days: 7 }).breakEvenMonthly, null);
  assert.equal(profitView({ sales: 100, grossProfit: -5, losses: 0, expenses: 0, salaries: 0, fixedPeriod: 0, fixedMonthly: 100, days: 7 }).breakEvenMonthly, null);
});

test("comparación con el período anterior", () => {
  assert.equal(changePct(120, 100), 20);
  assert.equal(changePct(-50, -100), 50);
  assert.equal(changePct(100, 0), null);
  assert.equal(changePct(100, null), null);
});
