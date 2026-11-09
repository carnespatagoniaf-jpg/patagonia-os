import test from "node:test";
import assert from "node:assert/strict";
import { ORDER_TO_CHARGE_KEY, matchOrderItems, orderToCharge, saveOrderToCharge, takeOrderToCharge } from "./order-to-charge";
import type { CustomerOrder } from "./orders-logic";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k)
  };
}

const order: CustomerOrder = {
  id: "o1", branchId: "b1", customerId: null, customerName: "Juana", customerPhone: null, pickupDate: "2026-11-10", pickupTime: null,
  notes: null, total: 50000, deposit: 10000, status: "pendiente", createdAt: "2026-11-09T10:00:00Z",
  items: [
    { productId: "p1", productName: "Mate imperial - Negro", quantity: 1, unit: "unit", notes: null },
    { productId: "p2", productName: "Bombilla pico de loro", quantity: 2, unit: "unit", notes: null }
  ]
};

test("se toma una sola vez y solo en su sucursal", () => {
  const s = memoryStorage();
  saveOrderToCharge(orderToCharge(order), s);
  assert.equal(takeOrderToCharge("otra", s), null);
  assert.ok(s.data.has(ORDER_TO_CHARGE_KEY), "si es de otra sucursal queda guardado");
  const taken = takeOrderToCharge("b1", s);
  assert.equal(taken?.orderId, "o1");
  assert.equal(taken?.deposit, 10000);
  assert.equal(takeOrderToCharge("b1", s), null);
});

test("algo roto en el guardado no rompe Mostrador", () => {
  const s = memoryStorage();
  s.setItem(ORDER_TO_CHARGE_KEY, "{no es json");
  assert.equal(takeOrderToCharge("b1", s), null);
  assert.equal(s.data.size, 0);
});

test("separa lo que se puede vender de lo que ya no está", () => {
  const { found, missing } = matchOrderItems(orderToCharge(order), [{ id: "p1" }]);
  assert.deepEqual(found, [{ product: { id: "p1" }, quantity: 1 }]);
  assert.deepEqual(missing, ["Bombilla pico de loro"]);
});
