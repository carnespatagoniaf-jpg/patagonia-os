import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSuggestions,
  fillToMinimum,
  splitByWeights,
  diffSummary,
  effectiveMin,
  formatQty,
  isLate,
  perDayFromSales,
  prepLinesFrom,
  qtyTotals,
  receiveDiffs,
  suggestQty,
  totalsLabel,
  transferDiffRows,
  whenLabel,
  type Transfer,
  type TransferItem
} from "./transfer-logic";

const item = (over: Partial<TransferItem>): TransferItem => ({
  id: "i",
  productId: "p",
  name: "Asado",
  code: "101",
  unit: "kg",
  requested: null,
  sent: null,
  received: null,
  unitCost: null,
  ...over
});

const transfer = (over: Partial<Transfer>): Transfer => ({
  id: "t",
  number: 1,
  fromBranchId: "planta",
  toBranchId: "centro",
  status: "pedido",
  neededBy: null,
  requestNotes: null,
  carrier: null,
  vehicle: null,
  showCost: false,
  remitoId: null,
  requestedAt: null,
  dispatchedAt: null,
  receivedAt: null,
  receivedByName: null,
  receiveNotes: null,
  cancelledAt: null,
  cancelReason: null,
  createdAt: "2026-11-02T21:00:00Z",
  items: [],
  ...over
});

test("mínimo: el del local manda; sin el del local, el general", () => {
  assert.equal(effectiveMin(10, 30), 30);
  assert.equal(effectiveMin(10, undefined), 10);
  assert.equal(effectiveMin(10, 0), 10);
  assert.equal(effectiveMin(-1, undefined), 0);
});

test("sugerencia: lo que falta para el mínimo, redondeado para arriba", () => {
  assert.equal(suggestQty(4.2, 30), 26);
  assert.equal(suggestQty(6, 25), 19);
  assert.equal(suggestQty(30, 30), 0);
  assert.equal(suggestQty(-3, 15), 15, "stock negativo cuenta como cero");
  assert.equal(suggestQty(0, 0), 0);
  assert.equal(suggestQty(29.999, 30), 1);
});

test("sugerencias: solo lo que está debajo del mínimo, sin presentaciones ni inactivos, lo más urgente primero", () => {
  const base = { code: null, unit: "kg" as const, productMin: 0, active: true, isPresentation: false };
  const rows = buildSuggestions(
    [
      { ...base, productId: "a", name: "Asado", stock: 4.2 },
      { ...base, productId: "v", name: "Vacío", stock: 0 },
      { ...base, productId: "n", name: "Nalga", stock: 40 },
      { ...base, productId: "o", name: "Oferta", stock: 0, isPresentation: true },
      { ...base, productId: "x", name: "De baja", stock: 0, active: false },
      { ...base, productId: "g", name: "General", stock: 1, productMin: 5 }
    ],
    new Map([["a", 30], ["v", 20], ["n", 25], ["o", 5], ["x", 5]]),
    new Map([["a", 11.5]])
  );
  assert.deepEqual(rows.map((r) => [r.productId, r.suggested]), [["v", 20], ["a", 26], ["g", 4]]);
  assert.equal(rows.find((r) => r.productId === "a")?.perDay, 11.5);
  assert.equal(rows.find((r) => r.productId === "v")?.perDay, 0);
  assert.equal(buildSuggestions([{ ...base, productId: "a", name: "Asado", stock: 0 }], new Map([["a", 3]]), null)[0].perDay, null);
});

test("venta por día", () => {
  const m = perDayFromSales([{ productId: "a", quantity: 28 }, { productId: null, quantity: 5 }, { productId: "a", quantity: 14 }], 28);
  assert.equal(m.get("a"), 1.5);
  assert.equal(m.size, 1);
  assert.equal(perDayFromSales([{ productId: "a", quantity: 1 }], 0).size, 0);
});

test("totales: kilos y unidades aparte, costo, y sin contar lo que va en cero", () => {
  const t = qtyTotals([
    { unit: "kg", qty: 26.4, unitCost: 10000 },
    { unit: "kg", qty: 0, unitCost: 9000 },
    { unit: "unit", qty: 4, unitCost: 500 },
    { unit: "kg", qty: 3 }
  ]);
  assert.deepEqual(t, { products: 3, kg: 29.4, units: 4, cost: 266000 });
  assert.equal(totalsLabel(t), "29,4 kg y 4 u.");
  assert.equal(totalsLabel(qtyTotals([])), "nada");
  assert.equal(formatQty(0.4, "kg"), "0,4 kg");
  assert.equal(formatQty(1234.5678), "1.234,568");
});

test("diferencias al recibir: faltante y sobrante, a costo", () => {
  const items = [
    item({ id: "a", sent: 26.4, unitCost: 10000 }),
    item({ id: "c", name: "Chorizo", sent: 9, unitCost: 9000 }),
    item({ id: "n", name: "Nalga", sent: 12, unitCost: 13000 }),
    item({ id: "z", name: "No se mandó", sent: 0 })
  ];
  const diffs = receiveDiffs(items, new Map([["a", 26], ["c", 9.4], ["n", 12]]));
  assert.deepEqual(diffs.map((d) => [d.itemId, d.diff, d.cost]), [["a", -0.4, -4000], ["c", 0.4, 3600]]);
  const s = diffSummary(diffs);
  assert.equal(s.missing.kg, 0.4);
  assert.equal(s.missing.cost, 4000);
  assert.equal(s.extra.cost, 3600);
  assert.equal(receiveDiffs(items, new Map()).length, 0, "sin anotar todavía no hay diferencias");
});

test("envíos recibidos: diferencias guardadas para el dueño", () => {
  const rows = transferDiffRows([
    transfer({ status: "recibido", items: [item({ id: "a", sent: 10, received: 9.2, unitCost: 100 }), item({ id: "b", sent: 5, received: 5 })] }),
    transfer({ status: "en_viaje", items: [item({ id: "c", sent: 10, received: null })] })
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].diff.diff, -0.8);
});

test("en viaje sin recibir más de un día", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  assert.equal(isLate({ status: "en_viaje", dispatchedAt: "2026-11-02T20:00:00Z" }, now), true);
  assert.equal(isLate({ status: "en_viaje", dispatchedAt: "2026-11-04T08:00:00Z" }, now), false);
  assert.equal(isLate({ status: "recibido", dispatchedAt: "2026-11-01T08:00:00Z" }, now), false);
});

test("cuándo, en hora argentina", () => {
  const now = new Date("2026-11-03T02:30:00Z"); // 2/11 23:30 en Argentina
  assert.equal(whenLabel("2026-11-02T23:15:00Z", now), "hoy 20:15");
  assert.equal(whenLabel("2026-11-01T11:10:00Z", now), "ayer 08:10");
  assert.equal(whenLabel("2026-10-30T15:00:00Z", now), "hace 3 días");
  assert.equal(whenLabel(null, now), "");
});

test("preparar: arranca con lo pedido; si ya se guardó, con lo guardado", () => {
  const pedido = transfer({ items: [item({ productId: "a", requested: 26, sent: null })] });
  assert.equal(prepLinesFrom(pedido)[0].send, "26");
  const guardado = transfer({
    status: "preparando",
    items: [item({ productId: "a", requested: 26, sent: 26.4 }), item({ productId: "p", requested: 9, sent: 0 }), item({ productId: "c", requested: null, sent: 13 })]
  });
  assert.deepEqual(prepLinesFrom(guardado).map((l) => l.send), ["26,4", "0", "13"]);
});

test("reparto proporcional a lo que vende cada local, en enteros y sin pasarse", () => {
  assert.deepEqual(splitByWeights(400, [60, 80, 40, 50, 50]), [86, 114, 57, 72, 71]);
  assert.equal(splitByWeights(400, [60, 80, 40, 50, 50]).reduce((a, b) => a + b, 0), 400);
  assert.deepEqual(splitByWeights(10, [0, 0]), [5, 5], "sin ventas: partes iguales");
  assert.deepEqual(splitByWeights(10.7, [1, 1, 1]), [4, 3, 3], "los decimales quedan en el origen");
  assert.deepEqual(splitByWeights(0, [1, 2]), [0, 0]);
});

test("completar hasta el mínimo, sin pasarse de lo comprado", () => {
  assert.deepEqual(fillToMinimum(100, [30, 50, 0]), [30, 50, 0]);
  assert.deepEqual(fillToMinimum(60, [30, 50, 10.2]), [10, 50, 0]);
  assert.deepEqual(fillToMinimum(60, [-5, 20]), [0, 20]);
});
