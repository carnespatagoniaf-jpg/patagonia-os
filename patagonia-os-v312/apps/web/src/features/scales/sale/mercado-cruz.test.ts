import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { addScannedItem, emptyPaper } from "./paper";
import { decodeScaleCode, type ScaleCatalogItem, type ScaleSaleProfile } from "./profile";

// REAL Mercado de la Cruz (24/11/2026): dos Systel leídas a las 18:48 y 19:16; formato general "20PPPPIIIIII", pero los
// 179 productos leídos imprimen con su propio "20PPPPCCCCCC" (P) / "21PPPPCCCCCC" (U).
const item = (code: number, name: string): ScaleCatalogItem => ({ code, name, saleType: "P", prices: [25800, 0], eanType: 1, eanConfig: "20PPPPCCCCCC" });
const profile: ScaleSaleProfile = {
  scaleKey: "systel-49318b94",
  brand: "systel",
  weighedFormat: "20PPPPIIIIII",
  unitFormat: "21PPPPIIIIII",
  totalFormat: "22AAIIIIIIII",
  amountDecimals: 0,
  genericCodes: [],
  catalog: [item(2, "PECETO"), item(111, "BOCADITO DE PAPA Y"), item(113, "PATITA DE POLLO JY")]
};

function withCheck(first12: string): string {
  const d = first12.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
}

describe("[REAL] Mercado de la Cruz: producto cargado en la Systel después de leerla", () => {
  it("el 112 (MILA DE PECETO, 0,735 kg = $13.892, código 2001120138923) no se agrega y dice qué hacer", () => {
    const d = decodeScaleCode("2001120138923", profile);
    assert.equal(d.kind, "item");
    if (d.kind !== "item") return;
    assert.equal(d.code, 112);
    assert.equal(d.quantity, null);
    const r = addScannedItem(emptyPaper(), d, [], [] as Product[]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /N\.º 112.*no estaba en la balanza cuando Patagonia la leyó/);
      assert.match(r.reason, /Mi balanza/);
    }
  });

  it("un producto leído sigue entrando con sus kilos (PECETO 0,530 kg)", () => {
    const d = decodeScaleCode(withCheck("200002000530"), profile);
    assert.equal(d.kind, "item");
    if (d.kind === "item") assert.equal(d.quantity, 0.53);
  });
});
