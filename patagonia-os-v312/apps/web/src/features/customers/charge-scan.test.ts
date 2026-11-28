import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { CARNES_PATAGONIA_CONFIG, CARNES_PATAGONIA_LABELS } from "../sale/scale-real-labels";
import { DEFAULT_SCALE_CONFIG } from "../sale/scale-barcode";
import { SCALE_CONFIG_UNKNOWN } from "../sale/scale-config-cache";
import { resolveChargeScan } from "./charge-scan";
import { mirrorLinks, mirrorProducts, realCatalog, targetProfile } from "../scales/sale/los-gringos-fixture";
import { expectedItemCode } from "../scales/sale/profile";
import type { ScaleSetup } from "../scales/sale/scale-sale-service";

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

describe("C4: la venta a cuenta lee las etiquetas con el MISMO resolvedor y la misma regla que Mostrador", () => {
  const catalog = realCatalog();
  const lgSetup: ScaleSetup = { profile: targetProfile(), links: mirrorLinks(catalog), readAt: null, repeatWindowMinutes: 10, active: true };
  const lgProducts = mirrorProducts(catalog).map((p) => ({ ...p, priceRetail: 5000 }));
  const M2 = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" as const };

  it("etiqueta de la Systel de la sucursal (perfil de Los gringos): su producto y sus kilos, no el formato de la sucursal", () => {
    const code = expectedItemCode(targetProfile().catalog.find((i) => i.code === 4)!, targetProfile(), 1.25)!;
    const r = resolveChargeScan(code, lgProducts, DEFAULT_SCALE_CONFIG, [], { calibrated: false, setups: [lgSetup] });
    assert.equal(r.type, "add");
    if (r.type === "add") {
      assert.equal(r.product.id, "p-4");
      assert.equal(r.quantity, 1.25);
    }
  });

  it("REAL M2 2000258567506 en un local con Systel: el Matambre de la Kretz, como en Mostrador", () => {
    const matambre = product("2", "Matambre novillo gorina", "kg", 13700);
    const r = resolveChargeScan("2000258567506", [...lgProducts, matambre], M2, [], { calibrated: true, setups: [lgSetup] });
    assert.ok(r.type === "add" && r.product.code === "2" && r.quantity === 4.275);
  });

  it("etiqueta con importe en un local con zona: los kilos salen del precio con el que imprimió la balanza (el de la zona)", () => {
    // Ticket real de la Aura de Pollo y mar: COSTELETAS $3.895 (2002103895000). La balanza del local tiene el precio de la zona.
    const costeletas = { ...product("21", "COSTELETAS", "kg", 15900), listPrices: { zona: { price: 17000, manual: true } } } as unknown as Product;
    const r = resolveChargeScan("2002103895000", [costeletas], M2, [], { calibrated: true, setups: [], zoneListId: "zona" });
    assert.ok(r.type === "add" && r.quantity === 0.229, "3.895 ÷ 17.000, no ÷ 15.900 (0,245)");
  });

  it("dos lecturas válidas (TOTAL 998 o producto 998): no se agrega, se elige igual que en Mostrador", () => {
    const r = resolveChargeScan(withCheck("209980210600"), [product("998", "PECHITO", "kg", 10000)], M2, [], { calibrated: true, setups: [] });
    assert.equal(r.type, "choose");
    if (r.type === "choose") assert.equal(r.options.length, 2);
  });
});

function withCheck(first12: string): string {
  const d = first12.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
}
