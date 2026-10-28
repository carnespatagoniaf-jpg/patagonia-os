import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { amountInputText, parseAmount } from "./money";

describe("parseAmount (formato argentino: punto de miles, coma decimal)", () => {
  it("interpreta miles y decimales", () => {
    assert.equal(parseAmount("1.234,56"), 1234.56);
    assert.equal(parseAmount("12.000"), 12000);
    assert.equal(parseAmount("0,5"), 0.5);
  });

  it("acepta números sin separadores y con espacios", () => {
    assert.equal(parseAmount("12000"), 12000);
    assert.equal(parseAmount("  1.000  "), 1000);
  });

  it("un número con punto y 1-2 decimales es decimal, no miles (costo precargado en Editar, real 28/10)", () => {
    assert.equal(parseAmount("14315.25"), 14315.25);
    assert.equal(parseAmount("15269.6"), 15269.6);
    assert.equal(parseAmount("57.17"), 57.17);
    assert.equal(parseAmount("1.200"), 1200);
    assert.equal(parseAmount("1.200.000"), 1200000);
  });

  it("amountInputText precarga con coma y parseAmount lo lee igual", () => {
    assert.equal(amountInputText(14315.25), "14315,25");
    assert.equal(amountInputText(22500), "22500");
    assert.equal(parseAmount(amountInputText(15269.6)), 15269.6);
  });

  it("devuelve NaN con texto no numérico (el llamador lo valida)", () => {
    assert.ok(Number.isNaN(parseAmount("abc")));
  });
});
