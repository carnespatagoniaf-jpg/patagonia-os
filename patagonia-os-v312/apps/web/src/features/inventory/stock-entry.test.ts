import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import type { BoxLabelFormat } from "../sale/box-label";
import { DEFAULT_SCALE_CONFIG } from "../sale/scale-barcode";
import { entryTotals, resolveEntryScan, type EntryLine } from "./stock-entry";

const product = (code: string, name: string, unit: "kg" | "unit" | "box", priceRetail = 1000, active = true) =>
  ({ id: `id-${code}`, code, name, unit, priceRetail, active }) as unknown as Product;

// REAL, Carplat S.A.: formato de sus cajas y cajas asociadas (17/11/2026).
const CARPLAT: BoxLabelFormat = {
  id: "f1", name: "Carplat", totalLength: 13, productStart: 0, productLength: 2, fixedStart: 2, fixedText: "",
  weightStart: 8, weightLength: 4, weightDivisor: 100, productMap: { "07": "id-219", "15": "id-15", "01": "id-1" }
};
const PRODUCTS = [
  product("219", "ROAST BEEF (KG)", "kg"),
  product("15", "TORTUGUITA (CAJA)", "kg"),
  product("1", "MATAMBRE (CAJA)", "kg"),
  product("5", "PALETA (CAJA)", "kg"),
  product("226", "HUESOS", "unit"),
  product("999", "VIEJO", "kg", 1000, false)
];

describe("resolveEntryScan", () => {
  it("[REAL] una caja de Carplat entra con su producto y sus kilos, y cuenta como caja", () => {
    const r = resolveEntryScan("711012717328", PRODUCTS, [CARPLAT], DEFAULT_SCALE_CONFIG, true);
    assert.equal(r.type, "line");
    if (r.type !== "line") return;
    assert.equal(r.line.productId, "id-219");
    assert.equal(r.line.quantity, 17.32);
    assert.equal(r.line.code, "0711012717328");
    assert.equal(r.line.box, true);
  });

  it("[REAL] sin la pantalla Paquetes la caja suma los kilos pero no cuenta cajas", () => {
    const r = resolveEntryScan("1511012722327", PRODUCTS, [CARPLAT], DEFAULT_SCALE_CONFIG, false);
    assert.ok(r.type === "line" && r.line.quantity === 22.32 && r.line.box === false && r.line.productId === "id-15");
  });

  it("una caja con un número sin asociar no entra y dice qué hacer", () => {
    const r = resolveEntryScan("0511012720706", PRODUCTS, [CARPLAT], DEFAULT_SCALE_CONFIG, true);
    assert.equal(r.type, "error");
    if (r.type === "error") assert.match(r.message, /Asociar/);
  });

  it("el código de un producto pide los kilos", () => {
    const r = resolveEntryScan("5", PRODUCTS, [CARPLAT], DEFAULT_SCALE_CONFIG, true);
    assert.ok(r.type === "product" && r.product.id === "id-5");
  });

  it("una etiqueta de la balanza del local (2 + PLU 5 + gramos 5) entra con sus kilos", () => {
    // PLU 00005 (PALETA), 0,125 kg. Verificador cualquiera: la balanza no se valida por EAN.
    const r = resolveEntryScan("2000050012501", PRODUCTS, [], DEFAULT_SCALE_CONFIG, true);
    assert.equal(r.type, "line");
    if (r.type === "line") {
      assert.equal(r.line.productId, "id-5");
      assert.equal(r.line.quantity, 0.125);
      assert.equal(r.line.box, true);
    }
  });

  it("un número largo que no es nada da error; un texto busca por nombre (sin dados de baja)", () => {
    assert.equal(resolveEntryScan("12345678901", PRODUCTS, [], DEFAULT_SCALE_CONFIG, true).type, "error");
    const r = resolveEntryScan("matambre", PRODUCTS, [], DEFAULT_SCALE_CONFIG, true);
    assert.ok(r.type === "search" && r.matches.length === 1 && r.matches[0].id === "id-1");
    const v = resolveEntryScan("viejo", PRODUCTS, [], DEFAULT_SCALE_CONFIG, true);
    assert.ok(v.type === "search" && v.matches.length === 0);
  });
});

describe("entryTotals", () => {
  it("suma kilos y cajas por producto; las unidades no suman kilos", () => {
    const line = (productId: string, unit: "kg" | "unit", quantity: number, box: boolean): EntryLine =>
      ({ key: Math.random().toString(), productId, name: productId, unit, quantity, code: "", box });
    const t = entryTotals([line("m", "kg", 21.7, true), line("p", "kg", 20.7, true), line("m", "kg", 19.76, true), line("h", "unit", 3, false)]);
    assert.equal(t.lines, 4);
    assert.equal(t.kg, 62.16);
    assert.equal(t.boxes, 3);
    assert.deepEqual(t.byProduct.map((r) => [r.productId, r.quantity, r.boxes]), [["m", 41.46, 2], ["p", 20.7, 1], ["h", 3, 0]]);
  });
});
