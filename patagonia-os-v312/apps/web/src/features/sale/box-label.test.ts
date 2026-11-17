import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { boxProblem, boxTicket, learnBoxLabelFormat, readWithFormat, resolveBoxScan, restoreLeadingZero, shiftProductCut, type BoxLabelFormat } from "./box-label";

const product = (code: string, name: string, unit: "kg" | "unit" | "box", priceRetail: number, active = true) =>
  ({ id: `id-${code}`, code, name, unit, priceRetail, active }) as unknown as Product;

// REAL, Carplat S.A. 16-17/11/2026 (fotos de las cajas).
const ROAST_BEEF = "0711012717328"; // 17,320 kg, producción 12/11
const ROAST_BEEF_SCANNED = "711012717328"; // como lo manda el lector (sin el 0)
const TORTUGUITA = "1511012722327"; // 22,320 kg, producción 12/11
const MATAMBRE_0611 = "0105012721704"; // 21,700 kg, producción 06/11: los números del medio cambian (050127)
const MATAMBRE_0611_SCANNED = "105012721704";
const MATAMBRE_1211_SCANNED = "111012719764"; // cargado como código de producto en su Stock

const CARPLAT: BoxLabelFormat = {
  id: "f1", name: "Carplat", totalLength: 13, productStart: 0, productLength: 2, fixedStart: 2, fixedText: "",
  weightStart: 8, weightLength: 4, weightDivisor: 100
};

// Sus productos de verdad: códigos 2xx, no el número de la caja.
const CARPLAT_PRODUCTS = [
  product("219", "ROAST BEEF (KG)", "kg", 14300),
  product("215", "TORTUGUITA (KG)", "kg", 14200),
  product("61", "MATAMBRE (ENVASADO)", "kg", 17500),
  product("1", "MATAMBRE", "box", 16900)
];
const CARPLAT_MAPPED: BoxLabelFormat = { ...CARPLAT, productMap: { "07": "id-219", "15": "id-215", "01": "id-61" } };

describe("[REAL] cajas de Carplat", () => {
  it("el lector manda 12 números si el código empieza con 0 (cajas 01 a 09): se repone", () => {
    assert.equal(restoreLeadingZero(ROAST_BEEF_SCANNED), ROAST_BEEF);
    assert.equal(restoreLeadingZero(MATAMBRE_0611_SCANNED), MATAMBRE_0611);
    assert.equal(restoreLeadingZero(TORTUGUITA), TORTUGUITA);
    // 12 números que con el 0 no son un EAN-13 válido: no se tocan.
    assert.equal(restoreLeadingZero("711012717329"), "711012717329");
  });

  it("aprende el formato con dos cajas del mismo día y NO exige los números del medio", () => {
    const r = learnBoxLabelFormat([{ code: ROAST_BEEF_SCANNED, kg: 17.32 }, { code: TORTUGUITA, kg: 22.32 }]);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    if (!r.ok) return;
    const { id: _id, name: _name, ...expected } = CARPLAT;
    assert.deepEqual(r.format, expected);
  });

  it("lee las cajas de dos días distintos: número de caja y kilos", () => {
    assert.deepEqual(
      [ROAST_BEEF_SCANNED, TORTUGUITA, MATAMBRE_1211_SCANNED, MATAMBRE_0611_SCANNED].map((c) => {
        const r = readWithFormat(c, CARPLAT);
        return r && [r.productDigits, r.weightKg];
      }),
      [["07", 17.32], ["15", 22.32], ["01", 19.76], ["01", 21.7]]
    );
  });

  it("en Mostrador: el número de caja va al producto asociado (219, 215, 61), con los kilos de la caja", () => {
    const got = [ROAST_BEEF_SCANNED, TORTUGUITA, MATAMBRE_0611_SCANNED].map((c) => {
      const r = resolveBoxScan(c, [CARPLAT_MAPPED], CARPLAT_PRODUCTS);
      return r && [r.product.code, r.quantity];
    });
    assert.deepEqual(got, [["219", 17.32], ["215", 22.32], ["61", 21.7]]);
  });

  it("[REAL 17/11] con cajas asociadas, una caja sin asociar NO cae en el producto de código 1", () => {
    const soloDos = { ...CARPLAT, productMap: { "07": "id-219", "15": "id-215" } };
    assert.equal(resolveBoxScan(MATAMBRE_0611_SCANNED, [soloDos], CARPLAT_PRODUCTS), null);
    assert.match(boxProblem(MATAMBRE_0611_SCANNED, [soloDos], CARPLAT_PRODUCTS) ?? "", /número 01.*todavía no tiene un producto/);
    assert.equal(resolveBoxScan(ROAST_BEEF_SCANNED, [soloDos], CARPLAT_PRODUCTS)?.product.code, "219");
  });

  it("sin ninguna asociada: busca por código (07 o 7); un producto por caja entra como 1", () => {
    const products = [product("7", "Roast beef", "kg", 12000), product("01", "Matambre caja", "box", 300000)];
    const a = resolveBoxScan(ROAST_BEEF_SCANNED, [CARPLAT], products);
    assert.equal(a?.product.name, "Roast beef");
    assert.equal(a?.quantity, 17.32);
    assert.equal(resolveBoxScan(MATAMBRE_0611_SCANNED, [CARPLAT], products)?.quantity, 1);
  });

  it("número sin producto, producto sin precio o desactivado: no es caja (null) y boxProblem explica", () => {
    assert.equal(resolveBoxScan(TORTUGUITA, [CARPLAT], CARPLAT_PRODUCTS), null);
    assert.match(boxProblem(TORTUGUITA, [CARPLAT], CARPLAT_PRODUCTS) ?? "", /número 15.*todavía no tiene un producto/);
    const sinPrecio = { ...CARPLAT, productMap: { "15": "id-215" } };
    assert.equal(resolveBoxScan(TORTUGUITA, [sinPrecio], [product("215", "TORTUGUITA (KG)", "kg", 0)]), null);
    assert.match(boxProblem(TORTUGUITA, [sinPrecio], [product("215", "TORTUGUITA (KG)", "kg", 0)]) ?? "", /no tiene precio/);
    assert.equal(resolveBoxScan(TORTUGUITA, [sinPrecio], [product("215", "TORTUGUITA (KG)", "kg", 100, false)]), null);
  });

  it("la marca del renglón de caja: CAJA- + el código completo (con el 0), nunca PQ (Planta)", () => {
    const r = resolveBoxScan(ROAST_BEEF_SCANNED, [CARPLAT_MAPPED], CARPLAT_PRODUCTS);
    assert.equal(r && boxTicket(r.code), "CAJA-0711012717328");
    assert.ok(!boxTicket(ROAST_BEEF).startsWith("PQ"));
  });

  it("otros códigos no son cajas: verificador mal, largos distintos", () => {
    assert.equal(boxProblem("0711012717329", [CARPLAT], []), null);
    assert.equal(boxProblem("207", [CARPLAT], []), null);
  });
});

describe("aprender el formato", () => {
  it("errores claros", () => {
    assert.equal(learnBoxLabelFormat([{ code: TORTUGUITA, kg: 22.32 }]).ok, false);
    assert.equal(learnBoxLabelFormat([{ code: TORTUGUITA, kg: 22.32 }, { code: TORTUGUITA, kg: 22.32 }]).ok, false);
    assert.equal(learnBoxLabelFormat([{ code: ROAST_BEEF, kg: 17.32 }, { code: TORTUGUITA, kg: 5 }]).ok, false);
  });

  it("cajas de días distintos: el producto sale largo (4) y se corrige con dos \"Uno menos\"", () => {
    const r = learnBoxLabelFormat([{ code: TORTUGUITA, kg: 22.32 }, { code: MATAMBRE_0611_SCANNED, kg: 21.7 }]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.format.productLength, 4);
    const fixed = shiftProductCut(shiftProductCut(r.format, -1)!, -1);
    assert.equal(fixed?.productLength, 2);
    assert.equal(readWithFormat(MATAMBRE_0611_SCANNED, { ...fixed!, id: "", name: "" })?.productDigits, "01");
  });

  it("dos productos que terminan igual: el corte se puede correr", () => {
    const other = "17110127" + "2232";
    const d = other.split("").map(Number);
    const check = (10 - (d.reduce((a, x, i) => a + x * (i % 2 === 0 ? 1 : 3), 0) % 10)) % 10;
    const r = learnBoxLabelFormat([{ code: ROAST_BEEF, kg: 17.32 }, { code: other + check, kg: 22.32 }]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.format.productLength, 1);
    assert.equal(shiftProductCut(r.format, +1)?.productLength, 2);
  });
});
