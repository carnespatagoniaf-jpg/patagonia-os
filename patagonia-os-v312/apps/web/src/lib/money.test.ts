import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAmount } from "./money";

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

  it("devuelve NaN con texto no numérico (el llamador lo valida)", () => {
    assert.ok(Number.isNaN(parseAmount("abc")));
  });
});
