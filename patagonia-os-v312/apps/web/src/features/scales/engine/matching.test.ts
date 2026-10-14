import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchScaleCatalog, namesEquivalent, normalizeName, type MatchProduct, type MatchScaleItem } from "./matching";

// Casos tomados de Los gringos (14/10): mismos nombres y códigos que tienen su balanza y su Patagonia.
const P = (id: string, code: string, name: string, unit = "kg", priceRetail = 0): MatchProduct => ({ id, code, name, unit, priceRetail });
const S = (code: number, name: string, byWeight: boolean, price = 0): MatchScaleItem => ({ code, name, byWeight, price });

const products = [
  P("p4", "4", "POLLO ENTEROxKG"),
  P("p13", "13", "PECHUGA S/H x1x3"),
  P("p30", "30", "MOLIDA x1"),
  P("p65", "65", "PAN RALLADO SOL DE CAMPO REBOZADOR 20KG"),
  P("p78", "78", "ARABES", "unit"),
  P("p96", "96", "PATA MUSLO MAYORISTA"),
  P("p102", "102", "BOCADITOS MUZZA"),
  P("p103", "103", "BOC.MUZ X CAJA", "box"),
  P("pa", "200", "VACIO"),
  P("pb", "201", "VACIO")
];

describe("[PURO] comparación automática balanza ↔ Patagonia", () => {
  it("nombres: sin acentos ni signos; la balanza corta el nombre", () => {
    assert.equal(normalizeName("Pechugá  s/h x1x3"), "PECHUGA S H X1X3");
    assert.ok(namesEquivalent("PAN RALLADO SOL", "PAN RALLADO SOL DE CAMPO REBOZADOR 20KG"));
    assert.ok(namesEquivalent("CAJON PECHUGA S/", "CAJON PECHUGA S/H"));
    assert.equal(namesEquivalent("BOCADITOS MUZZA", "PATA MUSLO MAYORISTA"), false);
  });

  it("mismo código + nombre + forma de venta → se vincula solo", () => {
    const r = matchScaleCatalog([S(4, "POLLO ENTEROxKG", true), S(13, "PECHUGA S/H x1x3", true)], products);
    assert.equal(r.auto, 2);
    assert.deepEqual(r.decisions[0], { kind: "auto", code: 4, productId: "p4", why: "codigo_y_nombre" });
  });

  it("mismo código y nombre pero otra forma de venta (30 MOLIDA: unidad en la balanza, kg en Patagonia) → a revisar", () => {
    const r = matchScaleCatalog([S(30, "MOLIDA x1", false)], products);
    assert.equal(r.decisions[0].kind, "pending");
    assert.equal(r.decisions[0].kind === "pending" && r.decisions[0].reason, "forma_de_venta");
  });

  it("el código es de OTRO producto (96 BOCADITOS vs 96 PATA MUSLO) → a revisar, sugiere el de nombre idéntico", () => {
    const r = matchScaleCatalog([S(96, "BOCADITOS MUZZA", true)], products);
    const d = r.decisions[0];
    assert.equal(d.kind, "pending");
    assert.equal(d.kind === "pending" && d.reason, "codigo_de_otro_producto");
    assert.equal(d.kind === "pending" && d.suggestionId, "p102");
  });

  it("código libre y nombre IDÉNTICO único (98 ARABES → 78 ARABES) → se vincula solo", () => {
    const r = matchScaleCatalog([S(98, "ARABES", false)], products);
    assert.deepEqual(r.decisions[0], { kind: "auto", code: 98, productId: "p78", why: "nombre_identico" });
  });

  it("nombres solo parecidos NUNCA vinculan solos (97 BOCADITOS CAJA ≠ BOC.MUZ X CAJA)", () => {
    const r = matchScaleCatalog([S(97, "BOCADITOS CAJA", false)], products);
    assert.equal(r.auto, 0);
    assert.equal(r.decisions[0].kind, "pending");
  });

  it("dos productos con el mismo nombre en Patagonia → a revisar (no se elige uno al azar)", () => {
    const r = matchScaleCatalog([S(500, "VACIO", true)], products);
    assert.equal(r.decisions[0].kind === "pending" && r.decisions[0].reason, "varios_candidatos");
  });

  it("código duplicado en Patagonia → a revisar", () => {
    const r = matchScaleCatalog([S(7, "X", true)], [P("a", "7", "X"), P("b", "7", "X")]);
    assert.equal(r.decisions[0].kind === "pending" && r.decisions[0].reason, "codigo_duplicado_en_patagonia");
  });

  it("lo que ya decidió una persona se respeta (aunque la comparación diría otra cosa)", () => {
    const r = matchScaleCatalog([S(96, "BOCADITOS MUZZA", true), S(30, "MOLIDA x1", false)], products, [
      { code: 96, kind: "product", productId: "p102" },
      { code: 30, kind: "libre", productId: null }
    ]);
    assert.equal(r.kept, 2);
    assert.equal(r.auto, 0);
  });

  it("vínculo a un producto desactivado → a revisar", () => {
    const r = matchScaleCatalog([S(4, "POLLO ENTEROxKG", true)], [{ ...products[0], active: false }], [{ code: 4, kind: "product", productId: "p4" }]);
    assert.equal(r.decisions[0].kind === "pending" && r.decisions[0].reason, "producto_desactivado");
  });

  it("producto que no existe en Patagonia → a revisar, sin sugerencia inventada", () => {
    const r = matchScaleCatalog([S(7999, "PRUEBA PATAGONIA", true)], products);
    assert.deepEqual(r.decisions[0], { kind: "pending", code: 7999, reason: "sin_producto", suggestionId: null, detail: "no hay un producto así en Patagonia" });
  });

  it("el precio no decide, solo se cuenta la diferencia", () => {
    const r = matchScaleCatalog([S(4, "POLLO ENTEROxKG", true, 5200)], [P("p4", "4", "POLLO ENTEROxKG", "kg", 5000)]);
    assert.equal(r.auto, 1);
    assert.equal(r.priceDiffs, 1);
  });
});
