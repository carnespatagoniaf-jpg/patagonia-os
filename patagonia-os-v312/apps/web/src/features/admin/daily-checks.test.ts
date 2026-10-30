import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DailyCheck } from "./admin-service";
import { dailyCheckIssues } from "./daily-checks";

const base: DailyCheck = { id: "1", name: "Carnicería", plan: "estandar", inTrial: false, products: 50, lastSaleAt: "2026-10-29T15:00:00Z", openShiftsOld: 0, oldestOpenShift: null, negativeStock: 0, belowCost: 0, stuckInvoices: 0, problems: 0 };
const now = Date.parse("2026-10-30T12:00:00Z");

describe("Para revisar hoy", () => {
  it("un cliente sin problemas no aparece", () => {
    assert.deepEqual(dailyCheckIssues(base, now), []);
  });
  it("sin productos / nunca vendió / no vende hace días", () => {
    assert.deepEqual(dailyCheckIssues({ ...base, products: 0, lastSaleAt: null }, now), ["No cargó ningún producto"]);
    assert.deepEqual(dailyCheckIssues({ ...base, lastSaleAt: null }, now), ["Nunca vendió por Mostrador"]);
    assert.deepEqual(dailyCheckIssues({ ...base, lastSaleAt: "2026-10-20T12:00:00Z" }, now), ["No vende por Mostrador hace 10 días"]);
  });
  it("caja abierta, facturas trabadas, precio bajo costo y stock negativo", () => {
    const issues = dailyCheckIssues({ ...base, openShiftsOld: 1, oldestOpenShift: "2026-10-27T10:00:00Z", stuckInvoices: 2, belowCost: 1, negativeStock: 12 }, now);
    assert.deepEqual(issues, ["Caja abierta hace 3 días", "2 facturas trabadas en ARCA", "1 producto con precio menor al costo", "12 productos con stock negativo"]);
  });
});
