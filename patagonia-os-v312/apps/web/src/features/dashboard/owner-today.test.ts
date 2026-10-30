import assert from "node:assert/strict";
import { describe, it } from "node:test";
// Las horas se muestran en la hora de la computadora: la prueba fija la de Argentina (CI corre en UTC).
process.env.TZ = "America/Argentina/Buenos_Aires";

import { ownerTodayLines, ownerTodayTotal, visibleBranches, type OwnerTodayRow } from "./owner-today";

const base: OwnerTodayRow = {
  branchId: "b1",
  branchName: "Centro",
  isVehicle: false,
  salesTotal: 0,
  salesCount: 0,
  lastSaleAt: null,
  voidedCount: 0,
  voidedTotal: 0,
  openSince: null,
  openCashier: null,
  closesToday: 0,
  closeDifference: null
};
const now = new Date("2026-10-30T15:00:00-03:00");

describe("Hoy en tus locales", () => {
  it("caja abierta hoy, con quién atiende", () => {
    const l = ownerTodayLines({ ...base, openSince: "2026-10-30T08:00:00-03:00", openCashier: "Lucía" }, now);
    assert.equal(l[0].tone, "ok");
    assert.match(l[0].text, /Caja abierta desde las 08:00 · Lucía/);
  });

  it("caja abierta desde ayer a la mañana: no se cerró", () => {
    const l = ownerTodayLines({ ...base, openSince: "2026-10-29T08:00:00-03:00" }, now);
    assert.equal(l[0].tone, "bad");
    assert.match(l[0].text, /no se cerró/);
  });

  it("sin abrir hoy", () => {
    assert.deepEqual(ownerTodayLines(base, now), [{ text: "No abrió la caja hoy", tone: "muted" }]);
  });

  it("cierre con faltante, sobrante o bien (tolerancia $500)", () => {
    assert.match(ownerTodayLines({ ...base, closesToday: 1, closeDifference: -12000 }, now)[0].text, /faltaron \$12\.000/);
    assert.equal(ownerTodayLines({ ...base, closesToday: 1, closeDifference: -12000 }, now)[0].tone, "bad");
    assert.match(ownerTodayLines({ ...base, closesToday: 2, closeDifference: 3000 }, now)[0].text, /2 cierres de hoy: sobraron \$3\.000/);
    assert.match(ownerTodayLines({ ...base, closesToday: 1, closeDifference: 300 }, now)[0].text, /dio bien/);
    assert.match(ownerTodayLines({ ...base, closesToday: 1, closeDifference: null }, now)[0].text, /dio bien/);
  });

  it("anuladas y última venta", () => {
    const l = ownerTodayLines({ ...base, openSince: "2026-10-30T08:00:00-03:00", voidedCount: 2, voidedTotal: 5400, salesCount: 10, lastSaleAt: "2026-10-30T14:32:00-03:00" }, now);
    assert.equal(l[1].text, "2 ventas anuladas ($5.400)");
    assert.equal(l[2].text, "Última venta 14:32");
  });

  it("camiones sin nada hoy no se muestran; total de todas", () => {
    const rows = [{ ...base, salesTotal: 1000, salesCount: 2 }, { ...base, branchId: "c", isVehicle: true }];
    assert.equal(visibleBranches(rows).length, 1);
    assert.deepEqual(ownerTodayTotal(rows), { total: 1000, count: 2 });
  });
});
