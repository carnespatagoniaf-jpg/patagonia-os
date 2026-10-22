import assert from "node:assert/strict";
import { test } from "node:test";
import { caiStatus, canIssueRemito, lastNumberByPointOfSale, parseRemito, remitoQuantityLabel, validateCaiForm, type RemitoCai } from "./remito-r";

const cai = (over: Partial<RemitoCai> = {}): RemitoCai => ({
  id: "c1", pointOfSale: 3, cai: "76123456789012", caiDue: "2026-12-31", numberFrom: 1, numberTo: 100, active: true, ...over
});

test("estado del CAI: vigente, por vencer, agotado, vencido y dado de baja", () => {
  assert.deepEqual(caiStatus(cai(), null, "2026-10-22"), { state: "vigente", used: 0, remaining: 100, daysLeft: 70, warn: false });
  assert.equal(caiStatus(cai(), 85, "2026-10-22").remaining, 15);
  assert.equal(caiStatus(cai(), 85, "2026-10-22").warn, true);
  assert.equal(caiStatus(cai({ caiDue: "2026-11-01" }), 3, "2026-10-22").warn, true);
  assert.equal(caiStatus(cai(), 100, "2026-10-22").state, "agotado");
  assert.equal(caiStatus(cai({ caiDue: "2026-10-21" }), null, "2026-10-22").state, "vencido");
  assert.equal(caiStatus(cai({ active: false }), null, "2026-10-22").state, "dado_de_baja");
  // CAI nuevo que arranca en 101 después de usar el anterior hasta 100.
  const s = caiStatus(cai({ numberFrom: 101, numberTo: 200 }), 100, "2026-10-22");
  assert.equal(s.used, 0);
  assert.equal(s.remaining, 100);
});

test("se puede emitir si algún CAI está vigente; el último número cuenta los anulados", () => {
  const last = lastNumberByPointOfSale([{ pointOfSale: 3, number: 7 }, { pointOfSale: 3, number: 9 }, { pointOfSale: 4, number: 2 }]);
  assert.equal(last.get(3), 9);
  assert.equal(last.get(4), 2);
  assert.equal(canIssueRemito([cai({ numberTo: 9 })], last, "2026-10-22"), false);
  assert.equal(canIssueRemito([cai({ numberTo: 9 }), cai({ id: "c2", numberFrom: 10, numberTo: 50 })], last, "2026-10-22"), true);
  assert.equal(canIssueRemito([], last, "2026-10-22"), false);
});

test("formulario del CAI: mismas reglas que la base", () => {
  const ok = { pointOfSale: "3", cai: "7612-3456-7890-12", caiDue: "2026-12-31", numberFrom: "1", numberTo: "500" };
  assert.equal(validateCaiForm(ok, "2026-10-22"), null);
  assert.match(validateCaiForm({ ...ok, cai: "1234" }, "2026-10-22")!, /14 números/);
  assert.match(validateCaiForm({ ...ok, pointOfSale: "0" }, "2026-10-22")!, /punto de venta/);
  assert.match(validateCaiForm({ ...ok, caiDue: "2026-10-01" }, "2026-10-22")!, /ya pasó/);
  assert.match(validateCaiForm({ ...ok, numberTo: "0" }, "2026-10-22")!, /hasta/);
});

test("lee un remito guardado", () => {
  const r = parseRemito({
    id: "r1", cai_id: "c1", point_of_sale: 3, number: 12, cai: "76123456789012", cai_due: "2026-12-31", issued_on: "2026-10-22",
    customer_charge_id: "ch1", status: "emitido", show_values: true, total: "15900",
    issuer: { business_name: "Don Julio SRL", cuit: "30712345678", address: "Av. Siempreviva 742" },
    receiver: { name: "Bar La Previa", number: 4, tax_id: null },
    items: [{ description: "Asado", unit: "kg", quantity: "1.5", unit_price: 10600, line_total: 15900 }]
  });
  assert.equal(r.number, 12);
  assert.equal(r.issuer.tradeName, null);
  assert.equal(r.receiver.number, 4);
  assert.equal(r.items[0].quantity, 1.5);
  assert.equal(remitoQuantityLabel(r.items[0]), "1,5 kg");
  assert.equal(remitoQuantityLabel({ quantity: 2, unit: "unit" }), "2 u.");
});
