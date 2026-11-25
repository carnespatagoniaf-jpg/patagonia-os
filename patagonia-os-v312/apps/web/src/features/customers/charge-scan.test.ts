import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { CARNES_PATAGONIA_CONFIG, CARNES_PATAGONIA_LABELS } from "../sale/scale-real-labels";
import { DEFAULT_SCALE_CONFIG } from "../sale/scale-barcode";
import { SCALE_CONFIG_UNKNOWN } from "../sale/scale-config-cache";
import { resolveChargeScan } from "./charge-scan";

const product = (code: string, name: string, unit: "kg" | "unit", priceRetail: number, active = true) =>
  ({ id: `id-${code}`, code, name, unit, priceRetail, active }) as unknown as Product;

describe("Clientes → venta a cuenta: escanear como en Mostrador", () => {
  const products = [
    ...[...new Set(CARNES_PATAGONIA_LABELS.map(([, plu]) => plu))].map((plu) => product(plu, `Producto ${plu}`, "kg", 10000)),
    product("7790001000014", "Gaseosa 1,5 L", "unit", 2500)
  ];

  it("código de barras exacto de un producto: 1 unidad", () => {
    const r = resolveChargeScan("7790001000014", products, CARNES_PATAGONIA_CONFIG);
    assert.equal(r.type, "add");
    if (r.type !== "add") return;
    assert.equal(r.product.name, "Gaseosa 1,5 L");
    assert.equal(r.quantity, 1);
  });

  it("[REAL] etiquetas de la balanza de Carnes Patagonia: producto y kilos exactos", () => {
    for (const [code, plu, kg] of CARNES_PATAGONIA_LABELS) {
      const r = resolveChargeScan(code, products, CARNES_PATAGONIA_CONFIG);
      assert.equal(r.type, "add", code);
      if (r.type !== "add") continue;
      assert.equal(r.product.code, plu, code);
      assert.equal(r.quantity, kg, code);
      assert.equal(r.confirm, undefined);
    }
  });

  it("etiqueta de un producto que no está en Patagonia: error, no agrega", () => {
    const r = resolveChargeScan("2000504011722", products.filter((p) => p.code !== "504"), CARNES_PATAGONIA_CONFIG);
    assert.equal(r.type, "error");
  });

  it("ticket de TOTAL de la balanza: no se carga (la venta a cuenta necesita los productos)", () => {
    const r = resolveChargeScan("2099998689326", products, DEFAULT_SCALE_CONFIG);
    assert.equal(r.type, "error");
    if (r.type === "error") assert.match(r.message, /TOTAL/);
  });

  it("texto que no es código: sigue buscando por nombre", () => {
    assert.equal(resolveChargeScan("vacio", products, CARNES_PATAGONIA_CONFIG).type, "search");
    assert.equal(resolveChargeScan("   ", products, CARNES_PATAGONIA_CONFIG).type, "search");
  });

  it("formato de la sucursal desconocido: un código exacto de producto se sigue leyendo", () => {
    assert.equal(resolveChargeScan("7790001000014", products, SCALE_CONFIG_UNKNOWN).type, "add");
  });
});
