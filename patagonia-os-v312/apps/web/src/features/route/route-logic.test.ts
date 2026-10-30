import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addLine,
  customerBalanceWithQueue,
  paidTotal,
  routePrice,
  saleError,
  stockAfterQueue,
  ticketTotal,
  whatsappNumber,
  whatsappText,
  type QueuedRouteSale,
  type RouteProduct
} from "./route-logic";

const jamon: RouteProduct = { id: "p1", code: "10", name: "Jamón cocido", unit: "kg", price: 15900, stock: 7.655 };
const queso: RouteProduct = { id: "p2", code: "20", name: "Queso tybo", unit: "kg", price: 21900, stock: 4.5 };

function sale(over: Partial<QueuedRouteSale> = {}): QueuedRouteSale {
  return {
    clientId: "c1",
    vehicleId: "v1",
    customerId: "k1",
    customerName: "Almacén Rosa",
    lines: [{ productId: "p1", name: "Jamón cocido", unit: "kg", quantity: 2.345, price: 15900 }, { productId: "p2", name: "Queso tybo", unit: "kg", quantity: 1, price: 21900 }],
    payments: [{ accountId: "a1", accountName: "Efectivo Camión 1", amount: 5000 }],
    total: 59186,
    createdAt: "2026-10-26T15:30:00Z",
    balanceBefore: 371300,
    status: "pending",
    ...over
  };
}

describe("venta en ruta", () => {
  it("el total redondea igual que la base (2,345 kg x 15.900 + 1 kg x 21.900 = 59.186, probado en staging)", () => {
    assert.equal(ticketTotal(sale().lines), 59186);
  });

  it("el mismo producto se junta en un renglón", () => {
    let lines = addLine([], jamon, 1.2);
    lines = addLine(lines, jamon, 0.8);
    lines = addLine(lines, queso, 0);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].quantity, 2);
  });

  it("no deja guardar sin cliente, sin productos o cobrando de más", () => {
    const s = sale();
    assert.match(saleError(s.lines, s.payments, null) ?? "", /cliente/);
    assert.match(saleError([], s.payments, "k1") ?? "", /producto/);
    assert.match(saleError(s.lines, [{ accountId: "a", accountName: "x", amount: 60000 }], "k1") ?? "", /más que el total/);
    assert.equal(saleError(s.lines, s.payments, "k1"), null);
    assert.equal(saleError(s.lines, [], "k1"), null); // todo a cuenta corriente
  });

  it("sin señal: el stock y el saldo del teléfono cuentan las ventas sin subir", () => {
    const queue = [sale(), sale({ clientId: "c2", status: "sent" })];
    const stock = stockAfterQueue([jamon, queso], queue);
    assert.equal(stock[0].stock, 5.31);
    assert.equal(stock[1].stock, 3.5);
    assert.equal(customerBalanceWithQueue({ id: "k1", name: "Almacén Rosa", balance: 371300 }, queue), 371300 + 59186 - 5000);
    assert.equal(paidTotal(sale().payments), 5000);
  });

  it("el texto de WhatsApp muestra total, lo pagado, lo que queda a cuenta y el saldo", () => {
    const text = whatsappText(sale({ balanceAfter: 425486 }), "La primera");
    assert.match(text, /\*La primera\*/);
    assert.match(text, /Jamón cocido: 2,345 kg/);
    assert.match(text, /Total: \$\s?59\.186/);
    assert.match(text, /Queda a cuenta: \$\s?54\.186/);
    assert.match(text, /Saldo de su cuenta: \$\s?425\.486/);
    assert.match(text, /no válido como factura/);
  });

  it("arma el número de WhatsApp argentino", () => {
    assert.equal(whatsappNumber("011 15 2345-6789"), "5491123456789");
    assert.equal(whatsappNumber("+54 9 2944 123456"), "5492944123456");
    assert.equal(whatsappNumber("2944 15 123456"), "5492944123456");
    assert.equal(whatsappNumber("123"), null);
  });
});

describe("precio mayorista en la ruta", () => {
  const chorizo = { price: 8100, listPrices: { may: 7290 } };
  it("cliente con lista: su precio", () => assert.equal(routePrice(chorizo, { priceListId: "may" }), 7290));
  it("cliente sin lista: minorista", () => assert.equal(routePrice(chorizo, {}), 8100));
  it("sin cliente elegido: minorista", () => assert.equal(routePrice(chorizo, null), 8100));
  it("producto sin precio en esa lista: minorista", () => assert.equal(routePrice({ price: 4200 }, { priceListId: "may" }), 4200));
});
