import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TicketLine } from "./sale-model";
import { lineGross } from "./sale-model";
import { addDetailScan, pendingTotals, scanTotal, TOTAL_LINE_NAME } from "./scale-total-detail";
import { detailGroupKeys } from "./ticket-detail";

/**
 * C7 (decisión del dueño, 26/11): un TOTAL de la balanza escaneado SOLO no se cobra nunca más como una línea sin
 * producto. Se detalla (etiqueta de cada producto, o producto + importe) y la suma tiene que dar el TOTAL; o, si las
 * etiquetas ya están en la venta y suman el TOTAL, el TOTAL solo confirma (sin cobrar dos veces).
 * El TOTAL de $14.550 es el de un ticket real de la Aura (0000014550003); los productos son de prueba.
 */

const KEY = "ticket-0000014550003";
const sum = (cart: TicketLine[]) => Math.round(cart.reduce((s, l) => s + lineGross(l), 0) * 100) / 100;
const tickets = (cart: TicketLine[]) => cart.reduce((s, l) => s + (l.source ? (l.scaleTickets ?? 1) : 0), 0);
const amountLabel = (id: string, qty: number, amount: number, stamp = `20${id}@1`): TicketLine => ({ key: `${id}|${stamp}`, kind: "product", productId: id, name: id.toUpperCase(), unit: "kg", quantity: qty, unitPrice: amount / qty, source: "scale", scaleTickets: 1, scaleAmount: amount, scaleTicket: stamp });
const weightLabel = (id: string, qty: number, price: number): TicketLine => ({ key: `${id}|scale`, kind: "product", productId: id, name: id.toUpperCase(), unit: "kg", quantity: qty, unitPrice: price, source: "scale", scaleTickets: 1 });
const P = (id: string, price: number) => ({ id, name: id.toUpperCase(), unit: "kg" as const, priceRetail: price });

describe("C7: TOTAL de la balanza sin detalle", () => {
  it("escaneado solo: NO se cobra; queda esperando el detalle (y Mostrador no deja cobrar así)", () => {
    const r = scanTotal([], KEY, 14550);
    assert.equal(r.kind, "detail");
    if (r.kind !== "detail") return;
    assert.equal(r.cart.length, 1);
    assert.equal(r.cart[0].source, "scale_total");
    assert.equal(r.cart[0].name, TOTAL_LINE_NAME);
    assert.deepEqual(pendingTotals(r.cart).map((l) => l.key), [KEY], "con un TOTAL sin detallar no se cobra");
  });

  it("detallado con etiquetas escaneadas y producto + importe: suma EXACTO el TOTAL, baja stock, cuenta UN ticket", () => {
    let cart = (scanTotal([], KEY, 14550) as { cart: TicketLine[] }).cart;
    const a = addDetailScan(cart, KEY, P("pollo", 5800), 1.5, 8700);
    assert.ok(a.ok);
    if (!a.ok) return;
    cart = a.cart;
    assert.equal(a.line.quantity, 1.5, "los kilos de la etiqueta, no recalculados");
    assert.equal(pendingTotals(cart).length, 1, "falta detallar: todavía no se cobra");
    const b = addDetailScan(cart, KEY, P("milanesa", 7800), null, 5850);
    assert.ok(b.ok && b.done);
    if (!b.ok) return;
    cart = b.cart;
    assert.equal(pendingTotals(cart).length, 0);
    assert.equal(sum(cart), 14550);
    assert.equal(tickets(cart), 1);
    assert.ok(cart.every((l) => l.kind === "product" && l.productId), "todas las líneas son productos (bajan stock)");
  });

  it("un producto que pasa lo que falta: no se agrega", () => {
    const cart = (scanTotal([], KEY, 14550) as { cart: TicketLine[] }).cart;
    const r = addDetailScan(cart, KEY, P("pollo", 5800), 3, 17400);
    assert.equal(r.ok, false);
  });

  it("etiquetas ya cargadas que suman exacto el TOTAL: el TOTAL confirma y NO agrega otra línea (sin doble cobro)", () => {
    const labels = [amountLabel("pollo", 1.5, 8700), amountLabel("milanesa", 0.75, 5850)];
    const r = scanTotal(labels, KEY, 14550);
    assert.equal(r.kind, "confirmed");
    if (r.kind !== "confirmed") return;
    assert.equal(r.cart.length, 2);
    assert.equal(sum(r.cart), 14550);
    assert.equal(tickets(r.cart), 1, "las dos etiquetas del ticket cuentan UN ticket para el control de balanza");
    assert.equal(detailGroupKeys(r.cart, r.cart[0].key).length, 2, "van juntas: sacar una saca el ticket entero");
    assert.ok(r.cart.some((l) => l.scaleTicket === `${KEY}#1`), "lleva la identidad del TOTAL: otro escaneo del mismo papel avisa que ya se cobró");
    assert.equal(scanTotal(r.cart, KEY, 14550).kind, "duplicate", "el mismo TOTAL otra vez no hace nada");
  });

  it("etiquetas de peso que suman el TOTAL también confirman", () => {
    const r = scanTotal([weightLabel("asado", 1.5, 9700)], KEY, 14550);
    assert.equal(r.kind, "confirmed");
  });

  it("etiquetas cargadas que NO suman el TOTAL: no se agrega nada y se explica", () => {
    const r = scanTotal([amountLabel("pollo", 1.5, 8700)], KEY, 14550);
    assert.equal(r.kind, "mismatch");
    if (r.kind === "mismatch") assert.match(r.message, /8\.700.*14\.550/);
  });

  it("productos buscados a mano (no de balanza) no cuentan para confirmar el TOTAL", () => {
    const manual: TicketLine = { key: "pollo", kind: "product", productId: "pollo", name: "POLLO", unit: "kg", quantity: 1.5, unitPrice: 9700 };
    const r = scanTotal([manual], KEY, 14550);
    assert.equal(r.kind, "detail");
  });
});
