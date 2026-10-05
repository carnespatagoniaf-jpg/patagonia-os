import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billingLabel, billingStatus, matchesBillingFilter, matchesCompanySearch, sortByBilling, type BillingInfo } from "./company-billing";

const TODAY = "2026-10-05";
const NOW = Date.parse("2026-10-05T15:00:00Z");

const base = { trialEndsAt: null, paidUntil: null } as const;
const paid: BillingInfo = { ...base, name: "Carnicería Paz", clientNumber: 3, paidUntil: "2026-11-05" };
const soon: BillingInfo = { ...base, name: "Pollo y Mar", clientNumber: 9, paidUntil: "2026-10-07" };
const overdue: BillingInfo = { ...base, name: "Don Julio", clientNumber: 7, paidUntil: "2026-09-30", contactPhone: "+54 9 294 455-1234" };
const trial: BillingInfo = { ...base, name: "La Vaca", clientNumber: 12, trialEndsAt: "2026-10-08T12:00:00Z" };
const trialExpired: BillingInfo = { ...base, name: "El Toro", clientNumber: 11, trialEndsAt: "2026-10-01T12:00:00Z" };
const none: BillingInfo = { ...base, name: "Frigorífico Sur", clientNumber: 1, province: "Río Negro" };

describe("billingStatus", () => {
  it("clasifica cada caso", () => {
    assert.equal(billingStatus(paid, TODAY, NOW), "paid");
    assert.equal(billingStatus(soon, TODAY, NOW), "due_soon");
    assert.equal(billingStatus(overdue, TODAY, NOW), "overdue");
    assert.equal(billingStatus(trial, TODAY, NOW), "trial");
    assert.equal(billingStatus(trialExpired, TODAY, NOW), "trial_expired");
    assert.equal(billingStatus(none, TODAY, NOW), "none");
  });
  it("vence hoy sigue pagado (por vencer), mañana ya debe", () => {
    assert.equal(billingStatus({ ...paid, paidUntil: TODAY }, TODAY, NOW), "due_soon");
    assert.equal(billingStatus({ ...paid, paidUntil: "2026-10-04" }, TODAY, NOW), "overdue");
  });
  it("un pago registrado manda sobre la prueba", () => {
    assert.equal(billingStatus({ ...paid, trialEndsAt: "2026-09-01T00:00:00Z" }, TODAY, NOW), "paid");
  });
});

describe("filtros y orden", () => {
  it("Pagaron / Deben / En prueba / Sin pagos", () => {
    const all = [paid, soon, overdue, trial, trialExpired, none];
    const pick = (f: Parameters<typeof matchesBillingFilter>[1]) => all.filter((c) => matchesBillingFilter(billingStatus(c, TODAY, NOW), f)).map((c) => c.clientNumber);
    assert.deepEqual(pick("paid"), [3, 9]);
    assert.deepEqual(pick("owes"), [7, 11]);
    assert.deepEqual(pick("trial"), [12]);
    assert.deepEqual(pick("none"), [1]);
  });
  it("primero a quién hay que cobrarle", () => {
    const sorted = sortByBilling([paid, none, trial, soon, trialExpired, overdue], TODAY, NOW).map((c) => c.clientNumber);
    assert.deepEqual(sorted, [7, 11, 9, 12, 1, 3]);
  });
});

describe("matchesCompanySearch", () => {
  it("por número, nombre sin tildes, teléfono y provincia", () => {
    assert.ok(matchesCompanySearch(overdue, "7"));
    assert.ok(matchesCompanySearch(overdue, "#7"));
    assert.ok(!matchesCompanySearch(paid, "7"));
    assert.ok(matchesCompanySearch(none, "frigorifico"));
    assert.ok(matchesCompanySearch(overdue, "4551234"));
    assert.ok(matchesCompanySearch(none, "rio negro"));
  });
});

describe("billingLabel", () => {
  it("textos", () => {
    assert.equal(billingLabel(paid, TODAY, NOW), "Pagó hasta 05/11/2026");
    assert.equal(billingLabel(soon, TODAY, NOW), "Vence en 2 días");
    assert.equal(billingLabel(overdue, TODAY, NOW), "Debe desde 30/09/2026");
    assert.equal(billingLabel(trialExpired, TODAY, NOW), "Prueba vencida, sin pago");
    assert.equal(billingLabel(none, TODAY, NOW), "Sin pagos registrados");
  });
});
