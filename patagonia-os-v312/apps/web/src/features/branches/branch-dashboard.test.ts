import { test } from "node:test";
import assert from "node:assert/strict";
import { branchAlerts, branchTotals, rankBranches, salesByWeekday, type BranchStats } from "./branch-dashboard";

const base = (over: Partial<BranchStats>): BranchStats => ({
  branchId: "b",
  branchName: "Local",
  sales: 0,
  prevSales: null,
  grossProfit: 0,
  result: 0,
  posSales: 0,
  posTotal: 0,
  kilos: 0,
  cashDifference: 0,
  cashShort: 0,
  shortShifts: 0,
  shifts: 0,
  shortCashier: null,
  voidedCount: 0,
  voidedAmount: 0,
  shiftOpen: true,
  lowStock: 0,
  ...over
});

const centro = base({ branchId: "c", branchName: "Centro", sales: 1000, prevSales: 900, grossProfit: 300, result: 120, posSales: 50, posTotal: 1000, kilos: 100, cashDifference: -148, cashShort: -148, shortShifts: 3, shifts: 10, shortCashier: { name: "Ana", shifts: 3 } });
const terminal = base({ branchId: "t", branchName: "Terminal", sales: 400, prevSales: 500, grossProfit: 60, result: -10, posSales: 20, posTotal: 400, kilos: 40, cashDifference: 4, shifts: 6, shiftOpen: false, lowStock: 6 });

test("ranking por lo vendido, con margen, ticket, barra y variación", () => {
  const rows = rankBranches([terminal, centro]);
  assert.deepEqual(rows.map((r) => r.branchName), ["Centro", "Terminal"]);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].marginPct, 30);
  assert.equal(rows[0].avgTicket, 20);
  assert.equal(rows[1].barPct, 40);
  assert.equal(rows[0].change, 11.1);
  assert.equal(rows[1].change, -20);
});

test("totales de todos los locales", () => {
  const t = branchTotals([centro, terminal]);
  assert.equal(t.sales, 1400);
  assert.equal(t.change, 0);
  assert.equal(t.marginPct, 25.7);
  assert.equal(t.avgTicket, 20);
  assert.equal(t.cashDifference, -144);
  assert.equal(t.cashShort, -148);
});

test("alertas: faltante con la misma cajera, caja sin abrir, caída, margen bajo y stock", () => {
  const rows = rankBranches([centro, terminal]);
  const alerts = branchAlerts(rows, { includesToday: true, hour: 12 });
  assert.equal(alerts[0].tone, "danger");
  assert.match(alerts[0].title, /Centro: faltaron \$ 148 en 3 cierres/);
  assert.match(alerts[0].detail, /todos de Ana/);
  const titles = alerts.map((a) => a.title).join(" | ");
  assert.match(titles, /Terminal no tiene la caja abierta/);
  assert.match(titles, /Terminal vendió 20% menos/);
  assert.match(titles, /Terminal deja menos margen: 15%/);
  assert.match(titles, /Terminal tiene 6 productos debajo del mínimo/);
  // De noche o en un período pasado no se avisa de la caja sin abrir.
  assert.ok(!branchAlerts(rows, { includesToday: true, hour: 22 }).some((a) => /caja abierta/.test(a.title)));
  assert.ok(!branchAlerts(rows, { includesToday: false, hour: 12 }).some((a) => /caja abierta/.test(a.title)));
});

test("ventas por día de la semana, sumando locales", () => {
  const r = salesByWeekday([[{ dow: 1, total: 10 }, { dow: 6, total: 5 }], [{ dow: 6, total: 7 }]]);
  assert.equal(r.length, 7);
  assert.equal(r[0].total, 10);
  assert.equal(r[5].total, 12);
});
