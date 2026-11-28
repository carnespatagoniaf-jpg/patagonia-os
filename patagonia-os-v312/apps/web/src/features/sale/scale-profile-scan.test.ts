import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { specFromKretz1070, specFromToday, specWithOwnPrefix, type ScaleLabelProfile } from "../scales/label-spec";
import { claimingProfiles, resolveScanByProfiles } from "./scale-profile-scan";
import { resolveScaleLabel } from "./scale-label-resolver";
import { resolveScan } from "./scan-resolve";
import type { ScaleConfig } from "./scale-barcode";

const ean = (twelve: string) => {
  const d = twelve.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return twelve + String((10 - (sum % 10)) % 10);
};
const prod = (code: string, name: string, unit: string, priceRetail: number) => ({ id: `id-${code}`, code, name, unit, priceRetail, cost: 0, stock: 0, minStock: 0, active: true }) as unknown as Product;
const PRODUCTS = [prod("1", "NALGA", "kg", 18000), prod("12", "VACIO", "kg", 15000), prod("120", "CHORIZO", "kg", 9000)];
const BRANCH_1_6_5: ScaleConfig = { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" };
const profile = (scaleKey: string, spec: ScaleLabelProfile["spec"], validUntil: string | null = null): ScaleLabelProfile => ({ scaleKey, name: scaleKey, spec, validUntil });

describe("Lector por balanza (balanzas_v2)", () => {
  it("el inicio más largo decide entre balanzas: un 22 es de la Aura, un 20 de la Report", () => {
    const report = profile("report", specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: null, list: "report_pesos" }));
    const aura = profile("aura", specWithOwnPrefix("kretz", "22"));
    const generic = profile("vieja", specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: BRANCH_1_6_5 }));
    assert.deepEqual(claimingProfiles([report, aura, generic], ean("220012126600")).map((p) => p.scaleKey), ["aura"]);
    assert.deepEqual(claimingProfiles([report, aura, generic], ean("200001219521")).map((p) => p.scaleKey), ["report"]);
    // Verificador mal o largo distinto: nadie la reconoce.
    assert.deepEqual(claimingProfiles([report, aura], "2200121266000"), []);
    assert.deepEqual(claimingProfiles([report, aura], "22001212660"), []);
  });

  it("dentro de una balanza cuentan también sus perfiles anteriores vigentes, aunque tengan un inicio más corto", () => {
    const now = profile("report", specFromKretz1070("2002005")!);
    const before = profile("report", specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: BRANCH_1_6_5 }), "2099-01-01T00:00:00Z");
    assert.deepEqual(claimingProfiles([now, before], ean("200001201250")).map((p) => p.validUntil), [null, "2099-01-01T00:00:00Z"]);
  });

  it("una etiqueta vieja que lee algo cobrable distinto que el formato nuevo: ambigua (no se cobra)", () => {
    const now = profile("report", specFromKretz1070("2002005")!);
    const before = profile("report", specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: BRANCH_1_6_5 }), "2099-01-01T00:00:00Z");
    // 2 000012 01250: con el 1-6-5 de antes = VACIO 1,250 kg; con el formato nuevo (y su lectura Kretz 2-5-5) = VACIO
    // por $1.250 (0,083 kg). Dos lecturas cobrables distintas: no se cobra ninguna sola.
    const r = resolveScanByProfiles(ean("200001201250"), PRODUCTS, [now, before], BRANCH_1_6_5);
    assert.equal(r.type, "ambiguous");
    if (r.type === "ambiguous") assert.deepEqual(r.options.map((o) => (o.type === "label" ? o.quantity : -1)).sort(), [0.083, 1.25]);
  });

  it("dos balanzas iguales (mismo formato) leen lo mismo: una sola lectura, sin ambigüedad", () => {
    const a = profile("a", specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: null, list: "report_plu5" }));
    const b = profile("b", specFromToday({ family: "kretz", model: "Kretz Report", branchConfig: null, list: "report_plu5" }));
    const raw = ean("210001201250");
    assert.deepEqual(resolveScanByProfiles(raw, PRODUCTS, [a, b], BRANCH_1_6_5), resolveScan(raw, PRODUCTS, specFromToday({ family: "kretz", model: null, branchConfig: null, list: "report_plu5" }).layout.prefix === 2 ? { prefixLength: 2, pluLength: 5, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" } : BRANCH_1_6_5));
  });

  it("un código que ninguna balanza reconoce se lee con el formato de la sucursal (sin las marcas de las listas)", () => {
    const aura = profile("aura", specWithOwnPrefix("kretz", "23"));
    const raw = ean("200001201250");
    assert.deepEqual(resolveScanByProfiles(raw, PRODUCTS, [aura], { ...BRANCH_1_6_5, auraPrefix22: true }), resolveScan(raw, PRODUCTS, BRANCH_1_6_5));
    // Un código de producto exacto sigue siendo el producto.
    assert.equal(resolveScanByProfiles("120", PRODUCTS, [aura], BRANCH_1_6_5).type, "product");
  });

  it("Kretz con inicio propio 23: producto 3 + centavos 7 y el 998 es el TOTAL", () => {
    const aura = profile("aura", specWithOwnPrefix("kretz", "23"));
    const label = resolveScanByProfiles(ean("230121875000"), PRODUCTS, [aura], BRANCH_1_6_5);
    assert.ok(label.type === "label" && label.product.code === "12" && label.quantity === 1.25 && label.amount === 18750, JSON.stringify(label));
    const total = resolveScanByProfiles(ean("239984210050"), PRODUCTS, [aura], BRANCH_1_6_5);
    assert.ok(total.type === "ticket_total" && total.amount === 42100.5, JSON.stringify(total));
  });

  it("en el resolvedor: mientras los perfiles cargan (sin copia en la PC) no se lee ninguna etiqueta", () => {
    const ctx = { products: PRODUCTS, config: BRANCH_1_6_5, calibrated: true, setups: [], labelProfiles: { status: "loading" as const, profiles: [] } };
    assert.equal(resolveScaleLabel(ean("200001201250"), ctx).type, "not_ready");
    assert.equal(resolveScaleLabel("12", ctx).type, "scan", "un producto por su código sí");
    // Sin el interruptor (labelProfiles null) lee como siempre.
    const off = resolveScaleLabel(ean("200001201250"), { ...ctx, labelProfiles: null });
    assert.ok(off.type === "scan" && off.resolution.type === "label" && off.resolution.product.code === "12");
  });
});
