import assert from "node:assert/strict";
import { test } from "node:test";
import {
  balanceDue,
  dayBannerText,
  daySummary,
  depositLabel,
  dueWithinHour,
  isOverdue,
  itemLabel,
  openCountByDate,
  planTotals,
  sortForDay,
  stepQuantity,
  validateDraft,
  type CustomerOrder
} from "./orders-logic";

const money = (n: number) => `$${n}`;

function order(partial: Partial<CustomerOrder>): CustomerOrder {
  return {
    id: partial.id ?? "o1",
    branchId: "b1",
    customerId: null,
    customerName: "Juan",
    customerPhone: null,
    pickupDate: "2026-12-24",
    pickupTime: null,
    notes: null,
    total: null,
    deposit: 0,
    status: "pendiente",
    createdAt: "2026-12-01T10:00:00Z",
    items: [],
    ...partial
  };
}

test("los botones − / + van de a medio kilo o de a uno y no bajan de cero", () => {
  assert.equal(stepQuantity(2, "kg", 1), 2.5);
  assert.equal(stepQuantity(0.5, "kg", -1), 0);
  assert.equal(stepQuantity(0, "kg", -1), 0);
  assert.equal(stepQuantity(1, "unit", 1), 2);
  assert.equal(stepQuantity(0.1, "kg", 1), 0.6);
});

test("cada producto se muestra con su unidad", () => {
  assert.equal(itemLabel({ quantity: 2.5, unit: "kg", productName: "Asado" }), "2,5 kg Asado");
  assert.equal(itemLabel({ quantity: 3, unit: "unit", productName: "Morcilla" }), "3 Morcilla");
  assert.equal(itemLabel({ quantity: 1, unit: "box", productName: "Hamburguesas" }), "1 caja Hamburguesas");
});

test("a cobrar = total − seña; seña y pagado", () => {
  assert.equal(balanceDue({ total: 50000, deposit: 10000 }), 40000);
  assert.equal(balanceDue({ total: null, deposit: 10000 }), null);
  assert.equal(depositLabel({ total: 50000, deposit: 10000 }, money), "Seña $10000 ya recibida");
  assert.equal(depositLabel({ total: 50000, deposit: 0 }, money), "Sin seña");
  assert.equal(depositLabel({ total: 50000, deposit: 50000 }, money), "Pagado");
});

test("orden del día por hora, los que no tienen hora al final", () => {
  const sorted = sortForDay([
    order({ id: "a", pickupTime: null }),
    order({ id: "b", pickupTime: "12:30:00" }),
    order({ id: "c", pickupTime: "09:00" })
  ]);
  assert.deepEqual(sorted.map((o) => o.id), ["c", "b", "a"]);
});

test("vencido: pasó la hora de hoy o es de un día anterior, y no se entregó", () => {
  const now = new Date(2026, 11, 24, 11, 30);
  assert.equal(isOverdue(order({ pickupTime: "11:00" }), "2026-12-24", now), true);
  assert.equal(isOverdue(order({ pickupTime: "12:00" }), "2026-12-24", now), false);
  assert.equal(isOverdue(order({ pickupTime: "11:00", status: "entregado" }), "2026-12-24", now), false);
  assert.equal(isOverdue(order({ pickupDate: "2026-12-23" }), "2026-12-24", now), true);
  assert.equal(isOverdue(order({ pickupTime: null }), "2026-12-24", now), false);
});

test("aviso del día: cuántos quedan y el primero que falta", () => {
  const now = new Date(2026, 11, 24, 10, 0);
  const orders = [
    order({ id: "a", pickupTime: "09:00" }),
    order({ id: "b", pickupTime: "11:00", status: "listo" }),
    order({ id: "c", pickupTime: "08:00", status: "entregado" }),
    order({ id: "d", pickupTime: "13:00", status: "cancelado" }),
    order({ id: "e", pickupDate: "2026-12-25", pickupTime: "10:00" })
  ];
  const summary = daySummary(orders, "2026-12-24", now);
  assert.deepEqual(summary, { open: 2, firstTime: "11:00", overdue: 1 });
  assert.equal(dayBannerText(summary, true), "Hoy tenés 2 pedidos para retirar. El primero es a las 11:00.");
  assert.equal(dayBannerText({ open: 0, firstTime: null, overdue: 0 }, true), "No quedan pedidos pendientes para hoy.");
});

test("aviso una hora antes: solo pendientes de hoy dentro de los próximos 60 minutos", () => {
  const now = new Date(2026, 11, 24, 10, 0);
  const due = dueWithinHour(
    [
      order({ id: "a", pickupTime: "10:45" }),
      order({ id: "b", pickupTime: "11:30" }),
      order({ id: "c", pickupTime: "10:30", status: "listo" }),
      order({ id: "d", pickupTime: "09:50" })
    ],
    "2026-12-24",
    now
  );
  assert.deepEqual(due.map((o) => o.id), ["a"]);
});

test("planificación: suma por producto, kilos y unidades separados, sin cancelados ni entregados", () => {
  const asado = { productId: "p1", productName: "Asado", unit: "kg" as const, notes: null };
  const chorizo = { productId: "p2", productName: "Chorizo", unit: "unit" as const, notes: null };
  const orders = [
    order({ id: "a", pickupDate: "2026-12-24", items: [{ ...asado, quantity: 2.5 }, { ...chorizo, quantity: 6 }] }),
    order({ id: "b", pickupDate: "2026-12-31", status: "listo", items: [{ ...asado, quantity: 3 }] }),
    order({ id: "c", pickupDate: "2026-12-24", status: "cancelado", items: [{ ...asado, quantity: 50 }] }),
    order({ id: "d", pickupDate: "2026-12-24", status: "entregado", items: [{ ...chorizo, quantity: 50 }] }),
    order({ id: "e", pickupDate: "2026-12-26", items: [{ ...asado, quantity: 9 }] })
  ];
  const plan = planTotals(orders, ["2026-12-24", "2026-12-31"]);
  assert.equal(plan.orders, 2);
  assert.deepEqual(plan.byKg.map((l) => [l.productName, l.quantity, l.orders]), [["Asado", 5.5, 2]]);
  assert.deepEqual(plan.byUnit.map((l) => [l.productName, l.quantity, l.orders]), [["Chorizo", 6, 1]]);
  assert.deepEqual(openCountByDate(orders), { "2026-12-24": 1, "2026-12-31": 1, "2026-12-26": 1 });
});

test("para guardar alcanza con nombre y un producto", () => {
  const item = { productId: "p1", productName: "Asado", unit: "kg" as const, quantity: 2, notes: "" };
  assert.equal(validateDraft({ customerName: " ", pickupDate: "2026-12-24", items: [item], total: null, deposit: 0 }), "Poné el nombre del cliente.");
  assert.equal(validateDraft({ customerName: "Ana", pickupDate: "2026-12-24", items: [{ ...item, quantity: 0 }], total: null, deposit: 0 }), "Agregá al menos un producto.");
  assert.equal(validateDraft({ customerName: "Ana", pickupDate: "2026-12-24", items: [item], total: 100, deposit: 200 }), "La seña no puede ser mayor que el total.");
  assert.equal(validateDraft({ customerName: "Ana", pickupDate: "2026-12-24", items: [item], total: null, deposit: 0 }), null);
});
