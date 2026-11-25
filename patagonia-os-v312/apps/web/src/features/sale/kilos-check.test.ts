import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gramsToKg, suspiciousKgLines, suspiciousKgQuestion } from "./kilos-check";
import type { TicketLine } from "./sale-model";

const line = (key: string, name: string, unit: "kg" | "unit", quantity: number): TicketLine => ({ key, kind: "product", productId: key, name, unit, quantity, unitPrice: 1000 });

describe("[REAL] El corte argentino 24/11/2026: gramos escritos como kilos", () => {
  const cart = [line("a", "VACIO", "kg", 4070), line("b", "CHORIZO PARMESANO", "kg", 0.31), line("c", "BIFE ANCHO", "kg", 1035), line("d", "Pepas", "unit", 150)];

  it("encuentra solo los renglones por kg con kilos absurdos", () => {
    const s = suspiciousKgLines(cart);
    assert.deepEqual(s.map((x) => [x.name, x.asGrams]), [["VACIO", 4.07], ["BIFE ANCHO", 1.035]]);
  });

  it("pasa a kilos solo esos renglones", () => {
    const fixed = gramsToKg(cart, suspiciousKgLines(cart).map((s) => s.key));
    assert.deepEqual(fixed.map((l) => l.quantity), [4.07, 0.31, 1.035, 150]);
  });

  it("una venta normal no pregunta nada", () => {
    assert.deepEqual(suspiciousKgLines([line("a", "ASADO", "kg", 2.465), line("b", "MEDIA RES", "kg", 98)]), []);
  });

  it("la pregunta dice qué quedaría", () => {
    assert.match(suspiciousKgQuestion(suspiciousKgLines(cart)), /VACIO 4,07 kg, BIFE ANCHO 1,035 kg/);
  });
});
