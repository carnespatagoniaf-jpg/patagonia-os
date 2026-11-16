import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { learnBoxLabelFormat, readWithFormat, resolveBoxScan, restoreLeadingZero, shiftProductCut, type BoxLabelFormat } from "./box-label";

const product = (code: string, name: string, unit: "kg" | "unit" | "box", priceRetail: number, active = true) =>
  ({ id: `id-${code}`, code, name, unit, priceRetail, active }) as unknown as Product;

// REAL, Carplat S.A. 16/11/2026 (fotos de las cajas).
const ROAST_BEEF = "0711012717328"; // 17,320 kg
const ROAST_BEEF_SCANNED = "711012717328"; // como lo manda el lector (sin el 0)
const TORTUGUITA = "1511012722327"; // 22,320 kg
const MATAMBRE_SCANNED = "111012719764"; // cargado como código de producto en su Stock

const CARPLAT: BoxLabelFormat = {
  id: "f1", name: "Carplat", totalLength: 13, productStart: 0, productLength: 2, fixedStart: 2, fixedText: "110127",
  weightStart: 8, weightLength: 4, weightDivisor: 100
};

describe("[REAL] cajas de Carplat", () => {
  it("el lector manda 12 números si el código empieza con 0: se repone", () => {
    assert.equal(restoreLeadingZero(ROAST_BEEF_SCANNED), ROAST_BEEF);
    assert.equal(restoreLeadingZero(TORTUGUITA), TORTUGUITA);
    // 12 números que con el 0 no son un EAN-13 válido: no se tocan.
    assert.equal(restoreLeadingZero("711012717329"), "711012717329");
  });

  it("aprende el formato con dos cajas y sus kilos", () => {
    const r = learnBoxLabelFormat([{ code: ROAST_BEEF_SCANNED, kg: 17.32 }, { code: TORTUGUITA, kg: 22.32 }]);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    const { id: _id, name: _name, ...expected } = CARPLAT;
    assert.deepEqual(r.format, expected);
  });

  it("lee las tres cajas: producto y kilos", () => {
    assert.deepEqual(
      [ROAST_BEEF_SCANNED, TORTUGUITA, MATAMBRE_SCANNED].map((c) => {
        const r = readWithFormat(c, CARPLAT);
        return r && [r.productDigits, r.weightKg];
      }),
      [["07", 17.32], ["15", 22.32], ["01", 19.76]]
    );
  });

  it("en Mostrador: producto por kg con los kilos de la caja; el código sin ceros también sirve", () => {
    const products = [product("7", "Roast beef", "kg", 12000), product("15", "Tortuguita", "kg", 11000), product("01", "Matambre caja", "box", 300000)];
    const a = resolveBoxScan(ROAST_BEEF_SCANNED, [CARPLAT], products);
    assert.equal(a?.type, "box");
    if (a?.type === "box") {
      assert.equal(a.product.name, "Roast beef");
      assert.equal(a.quantity, 17.32);
      assert.equal(a.code, ROAST_BEEF);
    }
    const m = resolveBoxScan(MATAMBRE_SCANNED, [CARPLAT], products);
    assert.equal(m?.type === "box" && m.quantity, 1, "por caja = 1");
  });

  it("producto que no existe o sin precio: error, no se agrega", () => {
    assert.equal(resolveBoxScan(TORTUGUITA, [CARPLAT], [])?.type, "error");
    assert.equal(resolveBoxScan(TORTUGUITA, [CARPLAT], [product("15", "Tortuguita", "kg", 0)])?.type, "error");
    assert.equal(resolveBoxScan(TORTUGUITA, [CARPLAT], [product("15", "Tortuguita", "kg", 100, false)])?.type, "error");
  });

  it("otros códigos no son cajas: etiquetas de balanza, códigos de productos, verificador mal", () => {
    assert.equal(resolveBoxScan("2009901890008", [CARPLAT], []), null);
    assert.equal(resolveBoxScan("7790001000012", [CARPLAT], []), null);
    assert.equal(resolveBoxScan("0711012717329", [CARPLAT], []), null);
    assert.equal(resolveBoxScan("207", [CARPLAT], []), null);
  });
});

describe("aprender el formato", () => {
  it("errores claros", () => {
    assert.equal(learnBoxLabelFormat([{ code: TORTUGUITA, kg: 22.32 }]).ok, false);
    assert.equal(learnBoxLabelFormat([{ code: TORTUGUITA, kg: 22.32 }, { code: TORTUGUITA, kg: 22.32 }]).ok, false);
    assert.equal(learnBoxLabelFormat([{ code: ROAST_BEEF, kg: 17.32 }, { code: TORTUGUITA, kg: 5 }]).ok, false);
  });

  it("dos productos que terminan igual: el corte se puede correr", () => {
    // 17 y 07: el 7 queda como fijo. Correrlo uno a la derecha lo devuelve al producto.
    const other = "17110127" + "2232";
    const d = other.split("").map(Number);
    const check = (10 - (d.reduce((a, x, i) => a + x * (i % 2 === 0 ? 1 : 3), 0) % 10)) % 10;
    const r = learnBoxLabelFormat([{ code: ROAST_BEEF, kg: 17.32 }, { code: other + check, kg: 22.32 }]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.format.productLength, 1);
    const fixed = shiftProductCut(r.format, ROAST_BEEF, +1);
    assert.equal(fixed?.productLength, 2);
    assert.equal(fixed?.fixedText, "110127");
  });
});
