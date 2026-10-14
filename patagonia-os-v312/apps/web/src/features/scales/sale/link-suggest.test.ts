import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { suggestByName } from "./link-suggest";
import type { ScaleCatalogItem } from "./profile";

// Nombres REALES de la balanza y del catálogo de Patagonia de Los gringos (14/10).
const item = (name: string, saleType: "P" | "U"): ScaleCatalogItem => ({ code: 1, name, saleType, prices: [1], eanType: 1, eanConfig: null });
const p = (code: string, name: string, unit: string) => ({ id: code, code, name, unit });
const patagonia = [
  p("31", "MOLIDA x5", "unit"), p("78", "ARABES", "unit"), p("79", "ARABES X 5 EFECTIVO", "unit"), p("102", "BOCADITOS MUZZA", "kg"),
  p("3", "MINDANAO CAJON DE POLLO", "unit"), p("80", "PASCUALINAS", "unit"), p("81", "PASCUALINAS X5 EFECTIVO", "unit"), p("82", "COMBO 1 EFECTIVO", "unit")
];

describe("sugerencia de vínculo por nombre (nombres REALES)", () => {
  it("sugiere solo el mismo nombre", () => {
    assert.equal(suggestByName(item("BOCADITOS MUZZA   ", "P"), patagonia)?.code, "102");
    assert.equal(suggestByName(item("ARABES            ", "U"), patagonia)?.code, "78");
    assert.equal(suggestByName(item("PASCUALINAS       ", "U"), patagonia)?.code, "80");
  });
  it("no sugiere un producto parecido pero distinto", () => {
    assert.equal(suggestByName(item("MOLIDA x1         ", "U"), patagonia), null);
    assert.equal(suggestByName(item("ARABES X 5        ", "U"), patagonia), null);
    assert.equal(suggestByName(item("COMBO 1           ", "U"), patagonia), null);
  });
  it("nombre cortado por la balanza (16 letras): vale si en Patagonia empieza igual", () => {
    assert.equal(suggestByName(item("MINDANAO CAJON D  ", "U"), patagonia)?.code, "3");
  });
  it("con otra forma de venta no sugiere", () => {
    assert.equal(suggestByName(item("BOCADITOS MUZZA   ", "U"), patagonia), null);
  });
});
