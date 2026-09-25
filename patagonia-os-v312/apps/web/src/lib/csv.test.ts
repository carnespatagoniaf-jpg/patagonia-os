import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("separa con punto y coma y filas con CRLF (Excel en español)", () => {
    assert.equal(toCsv(["a", "b"], [["x", 1], ["y", 2]]), "a;b\r\nx;1\r\ny;2");
  });

  it("entrecomilla y duplica comillas cuando hace falta", () => {
    assert.equal(toCsv(["n"], [['di "hola"'], ["a;b"], ["l1\nl2"]]), 'n\r\n"di ""hola"""\r\n"a;b"\r\n"l1\nl2"');
  });

  it("neutraliza fórmulas de Excel en textos (= + - @)", () => {
    assert.equal(toCsv(["n"], [["=SUM(A1)"], ["+1"], ["-cmd"], ["@x"]]), "n\r\n'=SUM(A1)\r\n'+1\r\n'-cmd\r\n'@x");
  });

  it("no toca números negativos reales ni un guion suelto", () => {
    assert.equal(toCsv(["n"], [[-5], ["-"]]), "n\r\n-5\r\n-");
  });
});
