import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCode, parseTemplate } from "../scales/sale/label-template";
import { decodeAcross } from "../scales/sale/multi-decode";
import type { ScaleSaleProfile } from "../scales/sale/profile";
import type { ScaleSetup } from "../scales/sale/scale-sale-service";
import type { TicketLine } from "./sale-model";
import { lineGross } from "./sale-model";
import { addDetailLine, detailGroupKeys, detailRemaining } from "./ticket-detail";

/**
 * Ticket de TOTAL con varios productos (Kretz Aura): detallarlo en Mostrador para que baje el stock, sin cambiar
 * nunca el importe cobrado. Y Mostrador con varias balanzas de venta en la sucursal (migración 134).
 * [SIMULADO]: el TOTAL usado ($14.550) es el de un ticket real (scale-barcode.test.ts); los productos son de prueba.
 */

const TOTAL_KEY = "ticket-0000014550003";
const total = (amount: number): TicketLine => ({ key: TOTAL_KEY, kind: "manual", name: "Ticket de balanza", unit: "unit", quantity: 1, unitPrice: amount, source: "scale_total", scaleTickets: 1 });
const P = (id: string, unit: "kg" | "unit", price: number) => ({ id, name: id.toUpperCase(), unit, priceRetail: price });
const sum = (cart: TicketLine[]) => Math.round(cart.reduce((s, l) => s + lineGross(l), 0) * 100) / 100;
const tickets = (cart: TicketLine[]) => cart.reduce((s, l) => s + (l.source ? (l.scaleTickets ?? 1) : 0), 0);

describe("[SIMULADO] Detallar un ticket de TOTAL de la balanza", () => {
  it("cada producto sale del total; el importe cobrado nunca cambia; al terminar el ticket cuenta una sola vez", () => {
    let cart = [total(14550)];
    const a = addDetailLine(cart, TOTAL_KEY, P("pollo", "kg", 5800), 8700);
    assert.ok(a.ok);
    if (!a.ok) return;
    cart = a.cart;
    assert.equal(a.done, false);
    assert.equal(detailRemaining(cart, TOTAL_KEY), 5850);
    assert.equal(sum(cart), 14550, "la venta sigue sumando el TOTAL");
    assert.equal(tickets(cart), 1, "el control de balanza sigue contando UN ticket");
    assert.equal(a.line.quantity, 1.5, "kilos = importe ÷ precio");
    const b = addDetailLine(cart, TOTAL_KEY, P("milanesa", "kg", 7800), 5850);
    assert.ok(b.ok);
    if (!b.ok) return;
    cart = b.cart;
    assert.equal(b.done, true);
    assert.equal(cart.some((l) => l.key === TOTAL_KEY), false, "detallado entero: la línea del TOTAL sale");
    assert.equal(sum(cart), 14550);
    assert.equal(tickets(cart), 1);
    assert.ok(cart.every((l) => l.kind === "product" && l.productId), "todo descuenta stock");
  });

  it("redondeo: los centavos van al último producto, la suma da EXACTO", () => {
    const r = addDetailLine([total(1000.4)], TOTAL_KEY, P("x", "kg", 3000), 1000);
    assert.ok(r.ok && r.done);
    if (r.ok) assert.equal(sum(r.cart), 1000.4);
  });

  it("no deja pasarse del total, ni productos sin precio, ni importes vacíos", () => {
    const cart = [total(5000)];
    assert.match((addDetailLine(cart, TOTAL_KEY, P("x", "kg", 1000), 6000) as { reason: string }).reason, /más de lo que falta/);
    assert.match((addDetailLine(cart, TOTAL_KEY, P("x", "kg", 0), 100) as { reason: string }).reason, /no tiene precio/);
    assert.match((addDetailLine(cart, TOTAL_KEY, P("x", "kg", 1000), 0) as { reason: string }).reason, /escribí el importe/);
    assert.match((addDetailLine([], TOTAL_KEY, P("x", "kg", 1000), 100) as { reason: string }).reason, /ya no está/);
  });

  it("unidades: se redondean a unidades enteras y el importe es el del papel", () => {
    const r = addDetailLine([total(3000)], TOTAL_KEY, P("huevos", "unit", 1450), 2900);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.line.quantity, 2);
      assert.equal(r.line.scaleAmount, 2900);
    }
  });

  it("sacar una línea del detalle saca el ticket entero (no queda medio ticket cobrado)", () => {
    const a = addDetailLine([total(14550)], TOTAL_KEY, P("pollo", "kg", 5800), 8700);
    assert.ok(a.ok);
    if (!a.ok) return;
    const keys = detailGroupKeys(a.cart, a.line.key);
    assert.deepEqual(new Set(keys), new Set([TOTAL_KEY, a.line.key]));
    assert.deepEqual(detailGroupKeys(a.cart, TOTAL_KEY).sort(), keys.sort());
    assert.deepEqual(detailGroupKeys([total(1)], TOTAL_KEY), [TOTAL_KEY]);
  });
});

// ── Mostrador con varias balanzas de venta ──────────────────────────────────────────────────────────────────────
function profile(key: string, weighed: string, totalFormat: string, codes: number[]): ScaleSaleProfile {
  return {
    scaleKey: key,
    brand: "systel",
    weighedFormat: weighed,
    unitFormat: null,
    totalFormat,
    amountDecimals: 0,
    genericCodes: [],
    catalog: codes.map((code) => ({ code, name: `P${code}`, saleType: "P" as const, prices: [1000], eanType: 0, eanConfig: null }))
  };
}
const setup = (p: ScaleSaleProfile): ScaleSetup => ({ profile: p, links: [], readAt: null, repeatWindowMinutes: 3, active: true });
const code = (tpl: string, v: Record<string, number>) => buildCode(parseTemplate(tpl)!, v)!;

describe("[SIMULADO] Mostrador lee con todas las balanzas de la sucursal", () => {
  const a = setup(profile("systel-a", "20PPPPCCCCCC", "22AAIIIIIIII", [13]));
  const b = setup(profile("systel-b", "25PPPPCCCCCC", "26AAIIIIIIII", [13]));

  it("cada código se lee con la balanza que lo imprimió", () => {
    const fromA = decodeAcross(code("20PPPPCCCCCC", { P: 13, C: 210 }), [a, b], null);
    const fromB = decodeAcross(code("25PPPPCCCCCC", { P: 13, C: 500 }), [a, b], null);
    assert.equal(fromA.kind === "match" && fromA.setup.profile.scaleKey, "systel-a");
    assert.equal(fromB.kind === "match" && fromB.setup.profile.scaleKey, "systel-b");
    assert.equal(decodeAcross("7790000000000", [a, b], null).kind, "not_scale", "un código de producto común sigue el camino normal");
  });

  it("dos balanzas con el MISMO formato: si dicen lo mismo se cobra igual; si dicen distinto, no se adivina", () => {
    const twin = setup(profile("systel-c", "20PPPPCCCCCC", "22AAIIIIIIII", [13]));
    const same = decodeAcross(code("20PPPPCCCCCC", { P: 13, C: 210 }), [a, twin], null);
    assert.equal(same.kind === "match" && same.setup.profile.scaleKey, "systel-a", "mismo producto y kilos: la primera, siempre");
    // La otra lee el mismo código con 5 cifras de producto: para ella es el 130, no el 13.
    const other = profile("systel-d", "20PPPPPCCCCC", "22AAIIIIIIII", [130]);
    const r = decodeAcross(code("20PPPPCCCCCC", { P: 13, C: 210 }), [a, setup(other)], null);
    assert.equal(r.kind, "ambiguous", "para cada balanza es otro producto: no se adivina");
    // Con un papel abierto de una de ellas, sus artículos y su TOTAL siguen siendo de esa.
    const pref = decodeAcross(code("20PPPPCCCCCC", { P: 13, C: 210 }), [a, twin], "systel-c");
    assert.equal(pref.kind === "match" && pref.setup.profile.scaleKey, "systel-c");
  });

  it("con una sola balanza funciona igual que antes", () => {
    const r = decodeAcross(code("22AAIIIIIIII", { A: 2, I: 780 }), [a], null);
    assert.ok(r.kind === "match" && r.decoded.kind === "total" && r.decoded.amount === 780);
  });
});

describe("[SIMULADO, formatos REALES Los gringos 19/10] Dos Systel: TOTAL con artículos (AA) y con número de balanza (BB)", () => {
  const vieja = setup(profile("systel", "20PPPPCCCCII", "22AAIIIIIIII", [4]));
  const nueva = setup(profile("systel-68afcb26", "20PPPPCCCCCC", "22BBIIIIIIII", [4]));
  // Real: los dos catálogos imprimen el producto 4 con su propio formato 20PPPPCCCCCC.
  for (const s of [vieja, nueva]) s.profile.catalog[0] = { ...s.profile.catalog[0], eanType: 1, eanConfig: "20PPPPCCCCCC" };

  it("la etiqueta del producto se lee igual en las dos (mismo producto y kilos)", () => {
    const r = decodeAcross(code("20PPPPCCCCCC", { P: 4, C: 1250 }), [vieja, nueva], null);
    assert.equal(r.kind, "match");
  });

  it("el TOTAL de la nueva (22 + 20 + importe) no se confunde con '20 artículos' de la vieja", () => {
    const total = code("22BBIIIIIIII", { B: 20, I: 6500 });
    const r = decodeAcross(total, [vieja, nueva], "systel", undefined, 1);
    assert.equal(r.kind === "match" && r.setup.profile.scaleKey, "systel-68afcb26", "con 1 artículo escaneado, es el TOTAL de la nueva");
    assert.ok(r.kind === "match" && r.decoded.kind === "total" && r.decoded.amount === 6500);
  });

  it("el TOTAL de la vieja con 20 artículos sigue siendo de la vieja", () => {
    const total = code("22AAIIIIIIII", { A: 20, I: 6500 });
    const r = decodeAcross(total, [vieja, nueva], null, undefined, 20);
    assert.equal(r.kind === "match" && r.setup.profile.scaleKey, "systel");
  });
});
