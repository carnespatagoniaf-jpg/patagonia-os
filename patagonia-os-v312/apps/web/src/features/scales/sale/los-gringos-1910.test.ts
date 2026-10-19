import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCode, parseTemplate } from "./label-template";
import { addScannedItem, closePaper, emptyPaper } from "./paper";
import { decodeScaleCode, type ScaleSaleProfile, type ScaleLink } from "./profile";

/**
 * Los gringos, 19/10/2026 a la tarde: la tarjeta "Balanza Systel" (systel-68afcb26) con su perfil y catálogo REALES de
 * producción (copiados de la base), después de apagar la tarjeta vieja y copiarle los 53 productos que la balanza vende
 * con su propio precio. Los códigos de barras se arman con el formato real de la balanza.
 */
const profile: ScaleSaleProfile = {
  scaleKey: "systel-68afcb26",
  brand: "systel",
  weighedFormat: "20PPPPCCCCCC",
  unitFormat: "21PPPPCCCCCC",
  totalFormat: "22BBIIIIIIII",
  amountDecimals: 0,
  genericCodes: [],
  catalog: [
    { code: 2, name: "GRINGO CAJON DE PO", saleType: "U", prices: [72000, 0], eanType: 1, eanConfig: "21PPPPCCCCCC" },
    { code: 4, name: "POLLO ENTEROxKG", saleType: "P", prices: [5200, 0], eanType: 1, eanConfig: "20PPPPCCCCCC" },
    { code: 14, name: "PECHUGA S/H x5X10", saleType: "P", prices: [8700, 8500], eanType: 1, eanConfig: "20PPPPCCCCCC" },
    { code: 70, name: "PASTAS 500gr", saleType: "U", prices: [2200, 0], eanType: 1, eanConfig: "21PPPPCCCCCC" }
  ]
};
const links: ScaleLink[] = [
  { code: 2, kind: "product", productId: "2af1c3a2-8ab3-4985-b8c3-dfd282c306d5" },
  { code: 4, kind: "product", productId: "ecd301db-f711-41e4-9db7-bda40c7da3ea" },
  { code: 14, kind: "product", productId: "8d458c43-e289-4be9-98d0-0e9b17042d5c" },
  { code: 70, kind: "product", productId: "4843c307-b51f-4c45-a5dd-a0a07321f37e" }
];
const products = [
  { id: "2af1c3a2-8ab3-4985-b8c3-dfd282c306d5", code: "2", name: "GRINGO CAJON DE POLLO", unit: "unit", priceRetail: 72000, active: true },
  { id: "ecd301db-f711-41e4-9db7-bda40c7da3ea", code: "4", name: "POLLO ENTEROxKG", unit: "kg", priceRetail: 5200, active: true },
  { id: "8d458c43-e289-4be9-98d0-0e9b17042d5c", code: "14", name: "PECHUGA S/H x5x10", unit: "kg", priceRetail: 0, active: true },
  { id: "4843c307-b51f-4c45-a5dd-a0a07321f37e", code: "70", name: "PASTAS 500gr", unit: "unit", priceRetail: 0, active: true }
] as never[];
const code = (tpl: string, v: Record<string, number>) => buildCode(parseTemplate(tpl)!, v)!;

describe("[datos REALES de producción] Los gringos 19/10: ticket de la balanza en Mostrador", () => {
  it("el código REAL de la venta de prueba (TOTAL 2220000732222) se lee como TOTAL de $73.222", () => {
    const d = decodeScaleCode("2220000732222", profile);
    assert.ok(d.kind === "total" && d.amount === 73222 && d.articles === null);
  });

  it("papel con un producto de los 48 mandados y otro de los 53 que la balanza vende con su precio: confirma y suma exacto", () => {
    let paper = emptyPaper();
    for (const raw of [code("20PPPPCCCCCC", { P: 4, C: 235 }), code("20PPPPCCCCCC", { P: 14, C: 1000 }), code("21PPPPCCCCCC", { P: 70, C: 2 })]) {
      const d = decodeScaleCode(raw, profile);
      assert.equal(d.kind, "item", raw);
      const r = addScannedItem(paper, d as never, links, products as never);
      assert.ok(r.ok, r.ok ? "" : r.reason);
      if (r.ok) paper = r.paper;
    }
    const total = 1222 + 8700 + 4400;
    const t = decodeScaleCode(code("22BBIIIIIIII", { B: 20, I: total }), profile);
    assert.equal(t.kind, "total");
    const r = closePaper(paper, t as never, undefined, { acceptSplit: true });
    assert.ok(r.ok, r.ok ? "" : JSON.stringify(r));
    if (r.ok) assert.equal(r.amounts.reduce((a, b) => a + b, 0), total);
  });
});
