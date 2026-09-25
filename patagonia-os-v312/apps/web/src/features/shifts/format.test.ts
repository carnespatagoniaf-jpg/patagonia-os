// Los clientes están en Argentina (UTC-3). Se fija la zona ANTES de usar Date.
process.env.TZ = "America/Argentina/Buenos_Aires";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDaysIso, endOfWeekIso, formatMoney, localDateIso, startOfMonthIso, startOfWeekIso } from "./format";

describe("fechas en hora argentina", () => {
  it("de noche sigue siendo el mismo día (toISOString ya diría mañana)", () => {
    const night = new Date("2026-09-24T23:30:00-03:00");
    assert.equal(night.toISOString().slice(0, 10), "2026-09-25");
    assert.equal(localDateIso(night), "2026-09-24");
  });

  it("suma días cruzando fin de mes y de año", () => {
    assert.equal(addDaysIso("2026-09-30", 1), "2026-10-01");
    assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
    assert.equal(addDaysIso("2026-03-01", -1), "2026-02-28");
  });

  it("semana de lunes a domingo", () => {
    assert.equal(startOfWeekIso("2026-09-24"), "2026-09-21"); // jueves
    assert.equal(endOfWeekIso("2026-09-24"), "2026-09-27");
    assert.equal(startOfWeekIso("2026-09-27"), "2026-09-21"); // domingo
  });

  it("inicio de mes", () => {
    assert.equal(startOfMonthIso("2026-09-24"), "2026-09-01");
  });
});

describe("formatMoney", () => {
  it("formato argentino sin decimales", () => {
    assert.match(formatMoney(1234567), /1\.234\.567/);
    assert.match(formatMoney(14550), /14\.550/);
  });
});
