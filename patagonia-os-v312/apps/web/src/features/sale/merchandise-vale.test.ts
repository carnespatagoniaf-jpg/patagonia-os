import { test } from "node:test";
import assert from "node:assert/strict";
import { valeItemsFromCart, valeReceiptDetail, valeTotal } from "./merchandise-vale";
import type { TicketLine } from "./sale-model";

const asado: TicketLine = { key: "a", kind: "product", productId: "p-asado", name: "Asado", unit: "kg", quantity: 1.25, unitPrice: 16500 };
const hamb: TicketLine = { key: "h", kind: "product", productId: "p-hamb", name: "Hamburguesa x4", unit: "unit", quantity: 2, unitPrice: 1500 };

test("arma los renglones para la base, con la lista de precios si la tiene", () => {
  const r = valeItemsFromCart([asado, { ...hamb, priceListId: "lista-may" }]);
  assert.deepEqual(r, { ok: true, items: [{ product_id: "p-asado", quantity: 1.25 }, { product_id: "p-hamb", quantity: 2, price_list_id: "lista-may" }] });
});

test("no deja dar un vale vacío, con un renglón suelto o un TOTAL de balanza", () => {
  assert.equal(valeItemsFromCart([]).ok, false);
  const manual = valeItemsFromCart([asado, { key: "m", kind: "manual", name: "Varios", unit: "unit", quantity: 1, unitPrice: 500 }]);
  assert.equal(manual.ok, false);
  assert.match(!manual.ok ? manual.problem : "", /Varios/);
  assert.equal(valeItemsFromCart([{ ...asado, scalePending: true }]).ok, false);
  assert.equal(valeItemsFromCart([{ ...hamb, quantity: 1.5 }]).ok, false);
});

test("total redondeado al peso, igual que la base, con y sin descuento", () => {
  assert.equal(valeTotal([asado, hamb], 0), 23625);
  assert.equal(valeTotal([{ ...asado, quantity: 1 }], 20), 13200);
  assert.equal(valeTotal([{ ...asado, quantity: 1.033 }], 15), 14488); // 1,033 × 16.500 × 0,85 = 14.487,8
  assert.equal(valeTotal([asado], 80), valeTotal([asado], 50)); // tope 50 %
});

test("el papelito lista lo que se lleva y el descuento", () => {
  const d = valeReceiptDetail([asado, hamb], 20);
  assert.match(d, /Asado 1,250 kg \$16\.500/);
  assert.match(d, /Hamburguesa x4 2 unidad \$2\.400/);
  assert.match(d, /20 % de descuento/);
  assert.doesNotMatch(valeReceiptDetail([asado], 0), /descuento/);
});
