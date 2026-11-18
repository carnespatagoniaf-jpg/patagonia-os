import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseReportLabel } from "./report-label";

describe("chooseReportLabel (formato de etiqueta de la Report)", () => {
  it("Lauda 18/11: los productos viejos usan otro formato (el 01 sale sin código) → se copia ese", () => {
    const samples = [
      { plu: 1, name: "MOLIDA C.", label: "01" }, // ya pisado por Patagonia
      { plu: 2, name: "ENTRAÑA", label: "01" },
      { plu: 37, name: "BONDIOLA/ENTERA", label: "03" },
      { plu: 40, name: "MATAMBRE CERDO", label: "03" }
    ];
    assert.equal(chooseReportLabel(samples, [1, 2]), "03");
  });

  it("si algún producto real ya usa el 01, queda el 01 (Report LT donde el 01 imprime el código)", () => {
    const samples = [
      { plu: 3, name: "ASADO", label: "01" },
      { plu: 50, name: "VACIO", label: "02" }
    ];
    assert.equal(chooseReportLabel(samples, []), "01");
  });

  it("sin productos reales (solo de fábrica, sin formato o de Patagonia) → 01", () => {
    const samples = [
      { plu: 1, name: "NOMBRE", label: "05" },
      { plu: 2, name: "NOMBRE 00002", label: "05" },
      { plu: 3, name: "POLLO", label: "00" },
      { plu: 4, name: "ASADO", label: "04" }
    ];
    assert.equal(chooseReportLabel(samples, [4]), "01");
    assert.equal(chooseReportLabel([], []), "01");
  });

  it("el más usado gana; empate → el número más bajo", () => {
    const samples = [
      { plu: 10, name: "A", label: "04" },
      { plu: 11, name: "B", label: "03" },
      { plu: 12, name: "C", label: "04" }
    ];
    assert.equal(chooseReportLabel(samples, []), "04");
    assert.equal(chooseReportLabel(samples.slice(0, 2), []), "03");
  });
});
