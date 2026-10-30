import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergedPerPlu, systelConfigForCodeAcross, templatesFromSetups, type RegisteredScaleFormats } from "./systel-label-format";

function ean(first12: string): string {
  const d = first12.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
}

const scale = (weighed: string, catalog: RegisteredScaleFormats["profile"]["catalog"] = [], brand = "systel"): RegisteredScaleFormats => ({
  profile: { brand, weighedFormat: weighed, unitFormat: weighed.replace(/^20/, "21"), totalFormat: "22BBIIIIIIII", catalog }
});

describe("[REAL Los gringos] formato de etiqueta Systel desde la base, por balanza (auditoría 29/10)", () => {
  // Ficha actual (activa): "20PPPPCCCCCC". Ficha vieja (desactivada): "20PPPPCCCCII".
  const label = ean("200013002150"); // producto 13, campo de cantidad 002150

  it("con la balanza activa se lee con SU formato", () => {
    const r = systelConfigForCodeAcross(label, templatesFromSetups([scale("20PPPPCCCCCC")]));
    assert.ok(r && r !== "no_soportado");
  });

  it("si dos balanzas de la sucursal leerían distinto, no se adivina", () => {
    const r = systelConfigForCodeAcross(label, templatesFromSetups([scale("20PPPPCCCCCC"), scale("20PPPPCCCCII")]));
    assert.equal(r, "no_soportado");
  });

  it("dos balanzas con el mismo formato leen igual", () => {
    const a = systelConfigForCodeAcross(label, templatesFromSetups([scale("20PPPPCCCCCC"), scale("20PPPPCCCCCC")]));
    const b = systelConfigForCodeAcross(label, templatesFromSetups([scale("20PPPPCCCCCC")]));
    assert.deepEqual(a, b);
  });

  it("una Kretz o una balanza sin formatos no cuenta", () => {
    assert.equal(templatesFromSetups([scale("20PPPPCCCCCC", [], "kretz")]).length, 0);
    assert.equal(systelConfigForCodeAcross(label, []), null);
  });

  it("los datos de cada producto salen del catálogo de la balanza", () => {
    const list = templatesFromSetups([scale("20PPPPCCCCCC", [{ code: 13, name: "PECHUGA", saleType: "P", prices: [5200, 0], eanType: 0, eanConfig: null }])]);
    assert.equal(mergedPerPlu(list)["13"]?.name, "PECHUGA");
    assert.equal(mergedPerPlu(list)["13"]?.p1, 5200);
  });
});
