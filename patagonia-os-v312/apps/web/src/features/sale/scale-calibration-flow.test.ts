import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWeightBarcode } from "./scale-barcode";
import { calibrationStep } from "./scale-calibration-flow";

function withCheckDigit(first12: string): string {
  const sum = first12.split("").reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + String((10 - (sum % 10)) % 10);
}

// Pantalla "Etiquetas de la balanza" (engranaje de Mostrador): con UNA etiqueta casi siempre hay dos formatos posibles
// (C6). La calibración no puede quedar frenada: pide el N.º de producto o una segunda etiqueta, y recién ahí guarda.
describe("calibración de etiquetas paso a paso", () => {
  const a = { code: withCheckDigit("200001201256"), value: 1.256 };

  it("una etiqueta ambigua: pregunta el N.º de producto (no guarda)", () => {
    const s = calibrationStep([a]);
    assert.equal(s.kind, "ask");
    if (s.kind === "ask") {
      assert.equal(s.ask, "plu");
      assert.match(s.message, /12.*120|120.*12/);
    }
  });

  it("con el N.º de producto guarda el formato que lo lee", () => {
    const s = calibrationStep([{ ...a, plu: "12" }]);
    assert.equal(s.kind, "save");
    if (s.kind === "save") assert.equal(parseWeightBarcode(a.code, s.config)?.plu, "12");
  });

  it("si con el N.º sigue la duda, pide una segunda etiqueta (mejor de más de 10 kg)", () => {
    const s = calibrationStep([{ code: withCheckDigit("200001201250"), value: 1.25, plu: "12" }]);
    assert.ok(s.kind === "ask" && s.ask === "label" && /10 kg/.test(s.message));
  });

  it("con la segunda etiqueta guarda", () => {
    const s = calibrationStep([{ code: withCheckDigit("200001201250"), value: 1.25, plu: "12" }, { code: withCheckDigit("200001212345"), value: 12.345 }]);
    assert.equal(s.kind, "save");
  });

  it("dos etiquetas y el N.º y todavía hay duda: no guarda nada y lo explica", () => {
    const s = calibrationStep([{ code: withCheckDigit("200001201250"), value: 1.25, plu: "12" }, { code: withCheckDigit("200001201350"), value: 1.35 }]);
    assert.equal(s.kind, "ambiguous");
    if (s.kind === "ambiguous") assert.match(s.message, /No se guardó nada/);
  });

  it("una etiqueta que no da con nada: none", () => {
    assert.equal(calibrationStep([{ code: withCheckDigit("200012012500"), value: 99.9 }]).kind, "none");
  });

  it("una etiqueta sin dudas guarda de una (como antes)", () => {
    // Real Carnes Patagonia: 2000035011987 = 35, 1,198 kg, con N.º de producto dado y una de más de 10 kg.
    assert.equal(calibrationStep([{ code: "2000035011987", value: 1.198 }, { code: withCheckDigit("200003512345"), value: 12.345 }]).kind, "save");
  });
});
