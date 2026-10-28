import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactSupportLog } from "./support-compact";

describe("diagnóstico para soporte (auditoría 28/10)", () => {
  it("si es largo, sigue siendo JSON válido y conserva el principio y el FINAL", () => {
    const intercambio = Array.from({ length: 5000 }, (_, i) => `renglón ${i} ${"x".repeat(30)}`);
    const text = compactSupportLog({ etapa: "frenada", mensaje: "lectura incompleta", intercambio });
    assert.ok(text.length <= 60000);
    const back = JSON.parse(text) as { intercambio: string[]; mensaje: string; recortado: unknown };
    assert.equal(back.mensaje, "lectura incompleta");
    assert.match(back.intercambio[0], /^renglón 0 /);
    assert.match(back.intercambio[back.intercambio.length - 1], /^renglón 4999 /);
    assert.ok(back.recortado);
  });

  it("si es corto, va completo y sin cambios", () => {
    const d = { etapa: "conectar", pasos: ["a", "b"] };
    assert.equal(compactSupportLog(d), JSON.stringify(d));
  });
});
