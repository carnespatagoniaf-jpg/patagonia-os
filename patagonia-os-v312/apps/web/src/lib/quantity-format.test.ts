import { test } from "node:test";
import assert from "node:assert/strict";
import { formatQuantity } from "./quantity-format";

test("kilos con coma decimal, no con punto", () => {
  assert.equal(formatQuantity(18.006, "kg"), "18,006 kg");
  assert.equal(formatQuantity(-3.11, "kg"), "-3,11 kg");
  assert.equal(formatQuantity(2, "kg"), "2 kg");
});

test("miles con punto y como mucho 3 decimales", () => {
  assert.equal(formatQuantity(1250.5, "kg"), "1.250,5 kg");
  assert.equal(formatQuantity(0.12345, "kg"), "0,123 kg");
});

test("unidades", () => {
  assert.equal(formatQuantity(3, "unit"), "3 u.");
  assert.equal(formatQuantity(4, "unit", "u"), "4 u");
  assert.equal(formatQuantity(Number.NaN, "unit"), "0 u.");
});
