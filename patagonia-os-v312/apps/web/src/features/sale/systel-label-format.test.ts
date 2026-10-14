import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Product } from "@patagonia/domain";
import { resolveScan } from "./scan-resolve";
import { LOS_GRINGOS_LABEL_CONFIG, TRIPLES_LABELS } from "./scale-real-labels";
import { configFromSystelTemplate, systelConfigForCode, type SystelLabelTemplates } from "./systel-label-format";

const product = (code: string, name: string, unit: "kg" | "unit", priceRetail: number) =>
  ({ id: `id-${code}`, code, name, unit, priceRetail, cost: 0, stock: 0, minStock: 0, active: true }) as unknown as Product;
const GRINGOS = [product("2", "GRINGO CAJON DE POLLO", "unit", 72000), product("5", "TROZADITOx1x2", "kg", 5200)];
const ean = (first12: string) => {
  const sum = first12.split("").map(Number).reduce((a, d, i) => a + d * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
};
const qty = (r: ReturnType<typeof resolveScan>) => (r.type === "label" ? [r.product.code, r.quantity] : r.type);

// Formatos REALES informados por la balanza de Los gringos (función 39).
const T_0910: SystelLabelTemplates = { weighed: "20PPPPCCCCCC", unit: "21PPPPCCCCCC", at: 0 };
const T_1310: SystelLabelTemplates = { weighed: "20PPPPCCCCII", unit: "21PPPPCCCCII", at: 0 };

describe("formato del código de cada producto según lo que informa la balanza Systel", () => {
  it("los dos formatos reales se convierten en la lectura correcta", () => {
    assert.deepEqual(configFromSystelTemplate("20PPPPCCCCCC"), { prefixLength: 2, pluLength: 4, weightLength: 6, weightDivisor: 1000, totalLength: 13, payloadType: "weight" });
    assert.deepEqual(configFromSystelTemplate("20PPPPCCCCII"), { prefixLength: 2, pluLength: 4, weightLength: 4, weightDivisor: 1000, totalLength: 13, payloadType: "weight" });
  });

  it("formato del 13/10 (20PPPPCCCCII): TROZADITO 0,215 kg se lee 0,215 kg (con el formato viejo serían 21,518 kg)", () => {
    const code = ean("200005021518"); // 20 + 0005 + 0215 (gramos) + 18 (importe, se ignora)
    assert.deepEqual(qty(resolveScan(code, GRINGOS, systelConfigForCode(code, T_1310) as never)), ["5", 0.215]);
    // El peligro que se evita: leerlo con el formato guardado en la sucursal (el del 09/10).
    assert.deepEqual(qty(resolveScan(code, GRINGOS, LOS_GRINGOS_LABEL_CONFIG)), ["5", 21.518]);
  });

  it("formato del 13/10, unitario (21PPPPCCCCII): CAJON 1 u.", () => {
    const code = ean("210002000172"); // 21 + 0002 + 0001 + 72
    assert.deepEqual(qty(resolveScan(code, GRINGOS, systelConfigForCode(code, T_1310) as never)), ["2", 1]);
  });

  it("formato del 09/10 (20PPPPCCCCCC) sigue igual: TROZADITO 0,215 kg y las etiquetas reales de TripleS", () => {
    const code = ean("200005000215");
    assert.deepEqual(qty(resolveScan(code, GRINGOS, systelConfigForCode(code, T_0910) as never)), ["5", 0.215]);
    const triples = TRIPLES_LABELS.map(([, plu, , name]) => product(plu, name, "kg", 10000));
    for (const [c, plu, kg] of TRIPLES_LABELS) assert.deepEqual(qty(resolveScan(c, triples, systelConfigForCode(c, T_0910) as never)), [plu, kg]);
  });

  it("formatos que no se pueden leer sin suponer (sin cantidad, o cantidad antes del producto): no se cargan", () => {
    assert.equal(configFromSystelTemplate("20PPPPIIIIII"), null);
    assert.equal(configFromSystelTemplate("20CCCCCCPPPP"), null);
    assert.equal(systelConfigForCode(ean("200005001118"), { weighed: "20PPPPIIIIII", unit: null, at: 0 }), "no_soportado");
  });

  it("códigos que no son de esa balanza (otro prefijo) siguen el camino normal; sin formato informado, también", () => {
    assert.equal(systelConfigForCode("2202000731184", T_1310), null); // TOTAL (22…)
    assert.equal(systelConfigForCode("7790001234567", T_1310), null);
    assert.equal(systelConfigForCode(ean("200005021518"), null), null);
  });
});
