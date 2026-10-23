import { test } from "node:test";
import assert from "node:assert/strict";
import { delayLabel, isValidAuthPin, minutesBetween, voidReasonText } from "./void-sale";

test("voidReasonText exige motivo", () => {
  assert.deepEqual(voidReasonText("", ""), { error: "Elegí por qué se anula." });
  assert.deepEqual(voidReasonText("El cliente se arrepintió", "ignorado"), { reason: "El cliente se arrepintió" });
  assert.deepEqual(voidReasonText("Otro", "  "), { error: "Escribí el motivo." });
  assert.deepEqual(voidReasonText("Otro", " se cortó la luz "), { reason: "Otro: se cortó la luz" });
});

test("isValidAuthPin acepta 4 a 6 números", () => {
  assert.equal(isValidAuthPin("1234"), true);
  assert.equal(isValidAuthPin("123456"), true);
  assert.equal(isValidAuthPin("123"), false);
  assert.equal(isValidAuthPin("12a4"), false);
});

test("delayLabel", () => {
  assert.equal(minutesBetween("2026-10-22T10:00:00Z", "2026-10-22T10:00:20Z"), 0);
  assert.equal(delayLabel(0), "al toque");
  assert.equal(delayLabel(12), "12 min después");
  assert.equal(delayLabel(60), "1 h después");
  assert.equal(delayLabel(135), "2 h 15 min después");
});
