import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { decodeAcross } from "../scales/sale/multi-decode";
import { addScannedItem, emptyPaper } from "../scales/sale/paper";
import { mirrorLinks, mirrorProducts, realCatalog, targetProfile } from "../scales/sale/los-gringos-fixture";
import { expectedItemCode } from "../scales/sale/profile";
import type { ScaleSetup } from "../scales/sale/scale-sale-service";
import { DEFAULT_SCALE_CONFIG, type ScaleConfig } from "./scale-barcode";
import { resolveScaleLabel } from "./scale-label-resolver";
import { SCALE_CONFIG_UNKNOWN } from "./scale-config-cache";

/**
 * C3 (auditoría 26/11): en un local con perfiles Systel (Los gringos), Mostrador probaba primero la lectura Systel y
 * se quedaba con cualquier etiqueta "20…", aunque fuera de una Kretz. Etiquetas Kretz REALES de M2 (2-3-7 con importe)
 * y de Oliem (2-5-5).
 */

const product = (code: string, name: string, unit: "kg" | "unit", priceRetail: number, id = `id-${code}`) =>
  ({ id, code, name, unit, priceRetail, active: true }) as unknown as Product;

function withCheck(first12: string): string {
  const d = first12.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
}

const catalog = realCatalog();
const lgSetup: ScaleSetup = { profile: targetProfile(), links: mirrorLinks(catalog), readAt: null, repeatWindowMinutes: 10, active: true };
const lgProducts = mirrorProducts(catalog).map((p) => ({ ...p, priceRetail: 5000 }));
const M2: ScaleConfig = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" };
const PLU5_WEIGHT: ScaleConfig = { prefixLength: 2, pluLength: 5, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" };
const matambre = product("2", "Matambre novillo gorina", "kg", 13700);
const promoPata = product("212", "PROMO PATA", "kg", 3333);

describe("C3: el error, con el código de hoy (la lectura Systel se queda con la etiqueta Kretz)", () => {
  it("REAL M2 2000258567506 (Matambre 4,275 kg $58.567,50) se lee como PATA DESH.x10 de 856,75 kg de la Systel", () => {
    const m = decodeAcross("2000258567506", [lgSetup], null);
    assert.equal(m.kind, "match");
    if (m.kind !== "match") return;
    const r = addScannedItem(emptyPaper(), m.decoded, lgSetup.links, [...lgProducts, matambre]);
    assert.ok(r.ok && r.item.productId === "p-25" && r.item.quantity === 856.75);
  });
});

describe("C3: resolvedor único (scale-label-resolver.ts)", () => {
  const products = [...lgProducts, matambre, promoPata];

  it("REAL M2 en un local con Systel + Kretz 2-3-7: es el Matambre de la Kretz (856 kg no lo pesa una Systel)", () => {
    const r = resolveScaleLabel("2000258567506", { products, config: M2, calibrated: true, setups: [lgSetup] });
    assert.equal(r.type, "scan");
    if (r.type === "scan") assert.ok(r.resolution.type === "label" && r.resolution.product.code === "2" && r.resolution.amount === 58567.5);
  });

  it("REAL Oliem 2000212051836 (PROMO PATA $5.183) con Systel en el local: la Kretz, no ALITAS de 205 kg", () => {
    const r = resolveScaleLabel("2000212051836", { products, config: PLU5_WEIGHT, calibrated: true, setups: [lgSetup] });
    assert.equal(r.type, "scan");
    if (r.type === "scan") assert.ok(r.resolution.type === "label" && r.resolution.product.code === "212" && r.resolution.quantity === 1.555);
  });

  it("2-3-7 de la tarea (20 012 0004500): el 120 no está en la Systel, así que es la Kretz", () => {
    const code = withCheck("200120004500");
    const r = resolveScaleLabel(code, { products: [...products, product("12", "CHORIZO", "kg", 9000)], config: M2, calibrated: true, setups: [lgSetup] });
    assert.ok(r.type === "scan" && r.resolution.type === "label" && r.resolution.product.code === "12" && r.resolution.amount === 45);
  });

  it("dos lecturas válidas y distintas: ambigua, con nombre, kilos e importe de cada una, sin agregar nada", () => {
    // Systel: producto 10 (PECHUGAC/H x1x5) 3,500 kg. Kretz 2-3-7: producto 1 con $35.
    const code = withCheck("200010003500");
    const r = resolveScaleLabel(code, { products: [...products, product("1", "ASADO", "kg", 10000)], config: M2, calibrated: true, setups: [lgSetup] });
    assert.equal(r.type, "ambiguous");
    if (r.type !== "ambiguous") return;
    assert.equal(r.options.length, 2);
    const titles = r.options.map((o) => o.title).join(" | ");
    assert.match(titles, /PECHUGAC\/H x1x5 3,500 kg/);
    assert.match(titles, /ASADO 0,004 kg \$\s?35/);
    assert.ok(r.options.some((o) => o.pick.type === "systel"));
    assert.ok(r.options.some((o) => o.pick.type === "label"));
  });

  it("las dos lecturas dicen lo mismo (mismo producto y kilos): la de la Systel, sin preguntar", () => {
    const pollo = product("4", "POLLO ENTERO", "kg", 5200, "p-4");
    const code = expectedItemCode(targetProfile().catalog.find((i) => i.code === 4)!, targetProfile(), 1.25)!;
    const sysConfig: ScaleConfig = { prefixLength: 2, pluLength: 4, weightLength: 6, weightDivisor: 1000, totalLength: 13, payloadType: "weight" };
    const r = resolveScaleLabel(code, { products: [...lgProducts.filter((p) => p.id !== "p-4"), pollo], config: sysConfig, calibrated: true, setups: [lgSetup] });
    assert.equal(r.type, "systel");
  });

  it("local solo con Systel y un formato viejo calibrado (Carnes premium, El Dorado, Los gringos…): la Systel, sin preguntar", () => {
    // Mismo código que el caso ambiguo de arriba, pero todas las balanzas activas del local son Systel.
    const code = withCheck("200010003500");
    const ctx = { products: [...products, product("1", "ASADO", "kg", 10000)], config: M2, calibrated: true, setups: [lgSetup] };
    assert.equal(resolveScaleLabel(code, { ...ctx, branchFormatCompetes: false }).type, "systel");
    // Sin saber qué balanzas hay (sin dato), compite: ante la duda, se pregunta.
    assert.equal(resolveScaleLabel(code, ctx).type, "ambiguous");
  });

  it("local solo con Systel: una etiqueta que la Systel no reconoce todavía se lee con el formato de la sucursal", () => {
    const r = resolveScaleLabel("2000258567506", { products, config: M2, calibrated: true, setups: [lgSetup], branchFormatCompetes: false });
    assert.ok(r.type === "scan" && r.resolution.type === "label" && r.resolution.product.code === "2");
  });

  it("formato de la sucursal sin calibrar (de fábrica): la lectura Systel, como siempre", () => {
    const code = withCheck("200010003500");
    const r = resolveScaleLabel(code, { products: [...products, product("1", "ASADO", "kg", 10000)], config: DEFAULT_SCALE_CONFIG, calibrated: false, setups: [lgSetup] });
    assert.equal(r.type, "systel");
  });

  it("producto que la Systel no tiene, sin otra lectura: el aviso de la Systel (no se agrega)", () => {
    const r = resolveScaleLabel("2009901890008", { products: lgProducts, config: DEFAULT_SCALE_CONFIG, calibrated: false, setups: [lgSetup] });
    assert.equal(r.type, "systel_message");
    if (r.type === "systel_message") assert.match(r.message, /no estaba en la balanza/);
  });

  it("una etiqueta Systel de verdad (POLLO ENTERO 1,250 kg) sigue entrando por la Systel", () => {
    const code = expectedItemCode(targetProfile().catalog.find((i) => i.code === 4)!, targetProfile(), 1.25)!;
    const r = resolveScaleLabel(code, { products, config: M2, calibrated: true, setups: [lgSetup] });
    assert.equal(r.type, "systel");
    if (r.type === "systel") assert.ok(r.product.id === "p-4" && r.quantity === 1.25);
  });

  it("sin perfiles Systel: lo de siempre (resolveScan con el formato de la sucursal)", () => {
    const r = resolveScaleLabel("2000258567506", { products, config: M2, calibrated: true, setups: [] });
    assert.ok(r.type === "scan" && r.resolution.type === "label" && r.resolution.product.code === "2");
  });

  it("el TOTAL 998 con un producto 998 (C2) también llega como ambigua por el resolvedor", () => {
    const r = resolveScaleLabel(withCheck("209980210600"), { products: [product("998", "PECHITO", "kg", 10000)], config: M2, calibrated: true, setups: [] });
    assert.equal(r.type, "ambiguous");
  });
});

describe("C5: con el formato todavía desconocido (cargando) no se lee ninguna etiqueta", () => {
  const products = [matambre, product("7790001000014", "Gaseosa", "unit", 2500)];

  it("REAL TOTAL de la Aura 2099802566003: hoy se cobraba igual con el formato desconocido; ahora 'Cargando la balanza…'", () => {
    const r = resolveScaleLabel("2099802566003", { products, config: SCALE_CONFIG_UNKNOWN, calibrated: false, setups: [], configStatus: "loading" });
    assert.equal(r.type, "not_ready");
    if (r.type === "not_ready") assert.match(r.message, /Cargando la balanza/);
  });

  it("REAL M2 2000258567506 cargando: no se agrega", () => {
    const r = resolveScaleLabel("2000258567506", { products, config: SCALE_CONFIG_UNKNOWN, calibrated: false, setups: [lgSetup], configStatus: "loading" });
    assert.equal(r.type, "not_ready");
  });

  it("sin conexión y sin copia: el aviso de cargar a mano", () => {
    const r = resolveScaleLabel("2000258567506", { products, config: SCALE_CONFIG_UNKNOWN, calibrated: false, setups: [], configStatus: "unknown" });
    assert.ok(r.type === "not_ready" && /a mano|escribí los kilos/.test(r.message));
  });

  it("el código exacto de un producto y la búsqueda por nombre siguen andando", () => {
    const a = resolveScaleLabel("7790001000014", { products, config: SCALE_CONFIG_UNKNOWN, calibrated: false, setups: [], configStatus: "loading" });
    assert.ok(a.type === "scan" && a.resolution.type === "product");
    const b = resolveScaleLabel("matambre", { products, config: SCALE_CONFIG_UNKNOWN, calibrated: false, setups: [], configStatus: "loading" });
    assert.ok(b.type === "scan" && b.resolution.type === "search");
  });
});
