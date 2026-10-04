import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseQuantity } from "./quantity";

describe("parseQuantity (kilos/unidades escritos a mano)", () => {
  it("acepta coma o punto como decimal", () => {
    assert.equal(parseQuantity("0,750"), 0.75);
    assert.equal(parseQuantity("0.750"), 0.75);
    assert.equal(parseQuantity("1,2"), 1.2);
    assert.equal(parseQuantity(",5"), 0.5);
    assert.equal(parseQuantity("3"), 3);
  });

  it("rechaza lo que no es un número", () => {
    for (const s of ["", ",", "1,2,3", "1.2.3", "abc", "-1", "1 kg"]) assert.ok(Number.isNaN(parseQuantity(s)), s);
  });
});
