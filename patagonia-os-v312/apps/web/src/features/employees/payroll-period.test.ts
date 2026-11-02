import { test } from "node:test";
import assert from "node:assert/strict";
import { earlierPending, shortDate, type PendingItem } from "./payroll-period";

const vale = (date: string, amount: number): PendingItem => ({ date, kind: "voucher", amount: -amount });

test("sin liquidaciones: todo lo anterior se puede sumar desde el más viejo", () => {
  const r = earlierPending([vale("2026-10-31", 100), vale("2026-10-23", 50), vale("2026-10-20", 10)], "2026-10-26", []);
  assert.equal(r.includable.length, 2);
  assert.equal(r.includeFrom, "2026-10-20");
  assert.equal(r.stuck.length, 0);
});

test("lo que cae en días ya liquidados no se puede sumar sin superponer", () => {
  const r = earlierPending(
    [vale("2026-10-23", 50), vale("2026-10-15", 30)],
    "2026-10-26",
    [{ periodStart: "2026-10-12", periodEnd: "2026-10-18" }]
  );
  assert.deepEqual(r.includable.map((i) => i.date), ["2026-10-23"]);
  assert.equal(r.includeFrom, "2026-10-23");
  assert.deepEqual(r.stuck.map((i) => i.date), ["2026-10-15"]);
});

test("nada pendiente antes del período", () => {
  const r = earlierPending([vale("2026-10-27", 10)], "2026-10-26", []);
  assert.equal(r.includeFrom, null);
  assert.equal(r.includable.length + r.stuck.length, 0);
});

test("shortDate", () => {
  assert.equal(shortDate("2026-10-31"), "31/10");
  assert.equal(shortDate("-"), "-");
});
