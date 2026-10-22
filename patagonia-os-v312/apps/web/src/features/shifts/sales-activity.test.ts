import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductSalesRow } from "./sales-by-category";
import { averageTicket, buildHourGrid, idleProducts, parseActivityReport, rankProducts } from "./sales-activity";

const row = (over: Partial<ProductSalesRow>): ProductSalesRow => ({
  productId: "p", productName: "X", productCode: "1", unit: "kg", categoryId: "c", categoryName: "C",
  quantity: 1, amount: 100, lines: 1, cost: 0, estimatedCostLines: 0, missingCostLines: 0, ...over
});

test("ranking: ordena por vendido, ganancia o kilos y deja afuera 'Sin producto'", () => {
  const rows = [
    row({ productId: "asado", amount: 150000, cost: 120000, quantity: 10 }),
    row({ productId: "vacio", amount: 100000, cost: 50000, quantity: 6 }),
    row({ productId: "pollo", amount: 60000, cost: 40000, quantity: 20 }),
    row({ productId: "huevos", unit: "unit", amount: 10, quantity: 100 }),
    row({ productId: null, amount: 900000 })
  ];
  assert.deepEqual(rankProducts(rows, "amount").map((r) => r.productId), ["asado", "vacio", "pollo", "huevos"]);
  assert.deepEqual(rankProducts(rows, "profit").map((r) => r.productId), ["vacio", "asado", "pollo", "huevos"]);
  // Por kilos, las unidades no entran.
  assert.deepEqual(rankProducts(rows, "quantity").map((r) => r.productId), ["pollo", "asado", "vacio"]);
  const vacio = rankProducts(rows, "profit")[0];
  assert.equal(vacio.profit, 50000);
  assert.equal(vacio.marginPct, 100);
});

test("sin ventas: con stock y no vendido, ordenado por plata parada; presentaciones cuentan para su principal", () => {
  const products = [
    { id: "asado", code: "1", name: "Asado", unit: "kg" as const, stock: 5, cost: 10000 },
    { id: "mondongo", code: "2", name: "Mondongo", unit: "kg" as const, stock: 8, cost: 3000 },
    { id: "lengua", code: "3", name: "Lengua", unit: "kg" as const, stock: 2, cost: 20000 },
    { id: "pollo", code: "4", name: "Pollo", unit: "kg" as const, stock: 30, cost: 2000 },
    { id: "pollo-cajon", code: "5", name: "Pollo cajón", unit: "box" as const, stock: 2, cost: 30000, stockSourceId: "pollo" },
    { id: "seso", code: "6", name: "Seso", unit: "kg" as const, stock: 0, cost: 1000 }
  ];
  const sold = [row({ productId: "asado", quantity: 3 }), row({ productId: "pollo-cajon", quantity: 1 })];
  assert.deepEqual(idleProducts(products, sold).map((p) => [p.id, p.value]), [
    ["lengua", 40000],
    ["mondongo", 24000]
  ]);
});

test("ticket promedio", () => {
  assert.equal(averageTicket(100000, 3), 33333.33);
  assert.equal(averageTicket(0, 0), 0);
});

test("lee la respuesta de sales_activity_report; sin permiso de caja los cierres quedan en null", () => {
  const r = parseActivityReport({
    cashiers: [
      { cashier_name: "Ana", with_pin: true, sales: 10, total: "250000.5", voided_count: 1, voided_amount: 5000, discount: 1200, shifts: 3, counted_shifts: 3, cash_difference: -93000, short_shifts: 2 },
      { cashier_name: "Beto", with_pin: false, sales: 4, total: 80000, voided_count: 0, voided_amount: 0, discount: 0, shifts: null, counted_shifts: null, cash_difference: null, short_shifts: null }
    ],
    hours: [{ dow: 6, hour: 11, sales: 5, total: "120000" }]
  });
  assert.equal(r.cashiers[0].total, 250000.5);
  assert.equal(r.cashiers[0].cashDifference, -93000);
  assert.equal(r.cashiers[1].shifts, null);
  assert.deepEqual(r.hours, [{ dow: 6, hour: 11, sales: 5, total: 120000 }]);
  assert.deepEqual(parseActivityReport(null), { cashiers: [], hours: [] });
});

test("grilla día × hora: completa horas intermedias y marca el mejor día y la mejor hora", () => {
  const g = buildHourGrid([
    { dow: 6, hour: 11, sales: 10, total: 300000 },
    { dow: 6, hour: 9, sales: 2, total: 40000 },
    { dow: 1, hour: 11, sales: 3, total: 50000 },
    { dow: 1, hour: 18, sales: 4, total: 90000 }
  ]);
  assert.deepEqual(g.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.equal(g.cells[5][2], 300000);
  assert.equal(g.cells[0][9], 90000);
  assert.equal(g.max, 300000);
  assert.equal(g.bestDay, 6);
  assert.equal(g.bestHour, 11);
  assert.equal(g.byHour.find((h) => h.hour === 11)!.total, 350000);
  assert.equal(g.byDay[0].sales, 7);
  assert.equal(buildHourGrid([]).bestDay, null);
});
