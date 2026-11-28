import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { specWithOwnPrefix, type ScaleLabelProfile } from "../scales/label-spec";
import { labelTestResult } from "../scales/label-test";
import { resolveEntryScan } from "../inventory/stock-entry";
import { describeScaleTicket } from "./scale-control";
import { readScaleCode } from "./scale-profile-scan";
import type { ScaleConfig } from "./scale-barcode";

/**
 * Con 'balanzas_v2', una Aura con inicio propio 22 (2-3-7, importe en centavos) se lee igual en TODAS las pantallas que
 * escanean etiquetas, no solo en Mostrador. Antes, la prueba de etiqueta, el Ingreso de stock, el Freezer, los Decomisos
 * y la anulación de tickets leían con el formato del local (acá 2-5-5 con peso) y daban otro producto u otros kilos.
 */
const ean = (twelve: string) => {
  const d = twelve.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return twelve + String((10 - (sum % 10)) % 10);
};
const prod = (code: string, name: string, priceRetail: number) => ({ id: `id-${code}`, code, name, unit: "kg", priceRetail, cost: 0, stock: 0, minStock: 0, active: true }) as unknown as Product;
const PRODUCTS = [prod("1", "NALGA", 20000), prod("12", "VACIO", 15000), prod("120", "CHORIZO", 9000)];
const BRANCH_2_5_5: ScaleConfig = { prefixLength: 2, pluLength: 5, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" };
const aura: ScaleLabelProfile = { scaleKey: "aura", name: "Aura", spec: specWithOwnPrefix("kretz", "22"), validUntil: null };
const READY = { status: "ready", profiles: [aura] };
// Aura inicio 22: producto 001 (NALGA), importe $5.000,00 → 0,250 kg a $20.000.
const LABEL = ean("220010500000");

describe("balanzas_v2: las otras pantallas leen la etiqueta igual que Mostrador", () => {
  it("el lector común da NALGA 0,250 kg con los perfiles, y NO eso con el formato del local", () => {
    const r = readScaleCode(LABEL, PRODUCTS, BRANCH_2_5_5, READY);
    assert.ok(r.type === "label" && r.product.code === "1" && Math.abs(r.quantity - 0.25) < 0.0005);
    const old = readScaleCode(LABEL, PRODUCTS, BRANCH_2_5_5, null);
    assert.ok(!(old.type === "label" && old.product.code === "1" && Math.abs(old.quantity - 0.25) < 0.0005));
  });

  it("prueba de etiqueta de Mis balanzas", () => {
    const r = labelTestResult(LABEL, { products: PRODUCTS, config: BRANCH_2_5_5, labelProfiles: READY });
    assert.ok(r?.ok, r?.detail);
    assert.match(r!.detail, /NALGA/);
  });

  it("Ingreso de stock / Freezer", () => {
    const r = resolveEntryScan(LABEL, PRODUCTS, [], BRANCH_2_5_5, false, READY);
    assert.ok(r.type === "line" && r.line.productId === "id-1" && Math.abs(r.line.quantity - 0.25) < 0.0005, JSON.stringify(r));
  });

  it("anular ticket y Decomisos", () => {
    const r = describeScaleTicket(LABEL, BRANCH_2_5_5, PRODUCTS, READY);
    assert.ok(r && r.kind === "label" && r.product.code === "1" && Math.abs((r.weightKg ?? 0) - 0.25) < 0.0005 && r.amount === 5000);
  });

  it("sin balanzas_v2 (perfiles null) todo sigue como antes", () => {
    assert.deepEqual(describeScaleTicket(LABEL, BRANCH_2_5_5, PRODUCTS, null), describeScaleTicket(LABEL, BRANCH_2_5_5, PRODUCTS));
  });
});
