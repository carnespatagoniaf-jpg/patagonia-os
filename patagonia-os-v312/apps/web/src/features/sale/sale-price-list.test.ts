import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { lineGross, withPriceList, type TicketLine } from "./sale-model";

const chorizo: Product = {
  id: "p1", code: "105", name: "Chorizo", unit: "kg", cost: 6000, priceRetail: 8100, stock: 10, minStock: 0,
  listPrices: { may: { price: 7290, manual: false } }
};
const weighed: TicketLine = { key: "p1|scale", kind: "product", productId: "p1", name: "Chorizo", unit: "kg", quantity: 1.25, unitPrice: 8100, source: "scale", scaleTickets: 1 };
const amountLabel: TicketLine = { ...weighed, key: "aura-1", unitPrice: 8100, scaleAmount: 10125, scaleTicket: "T1" };

describe("Mostrador con precio mayorista (igual que create_pos_sale)", () => {
  it("etiqueta con kilos: 1,25 kg × 7.290 = 9.112,50", () => {
    const l = withPriceList(weighed, chorizo, "may");
    assert.equal(l.unitPrice, 7290);
    assert.equal(l.priceListId, "may");
    assert.equal(lineGross(l), 9112.5);
  });
  it("etiqueta con importe: 10.125 de la balanza → 9.112,50", () => {
    assert.equal(lineGross(withPriceList(amountLabel, chorizo, "may")), 9112.5);
  });
  it("volver a Minorista deja la línea como estaba", () => {
    const back = withPriceList(withPriceList(weighed, chorizo, "may"), chorizo, null);
    assert.deepEqual(back, weighed);
    const backLabel = withPriceList(withPriceList(amountLabel, chorizo, "may"), chorizo, null);
    assert.equal(lineGross(backLabel), 10125);
    assert.equal(backLabel.priceListId, undefined);
  });
  it("aplicarla dos veces da lo mismo", () => {
    const once = withPriceList(weighed, chorizo, "may");
    assert.deepEqual(withPriceList(once, chorizo, "may"), once);
  });
  it("producto sin precio en la lista: minorista", () => {
    const l = withPriceList(weighed, { ...chorizo, listPrices: undefined }, "may");
    assert.equal(lineGross(l), 10125);
  });
  it("las líneas a mano y las etiquetas esperando el TOTAL no cambian", () => {
    const manual: TicketLine = { key: "m", kind: "manual", name: "Bolsa", unit: "unit", quantity: 1, unitPrice: 100 };
    assert.equal(withPriceList(manual, undefined, "may"), manual);
    const pending: TicketLine = { ...weighed, scalePending: true };
    assert.equal(withPriceList(pending, chorizo, "may"), pending);
  });
});
