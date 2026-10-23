import { test } from "node:test";
import assert from "node:assert/strict";
import { chequeAlerts, dueInfo, lastDepositDay, sortCheques, undoLabel, validateChequeInput, type Cheque } from "./cheque-logic";

const TODAY = "2026-10-22";

function cheque(over: Partial<Cheque>): Cheque {
  return {
    id: Math.random().toString(36).slice(2),
    kind: "received",
    echeq: false,
    number: "1",
    bank: null,
    drawerName: null,
    drawerCuit: null,
    amount: 1000,
    payDate: TODAY,
    status: "in_portfolio",
    customerName: null,
    supplierName: null,
    bankAccountName: null,
    stepDate: null,
    notes: null,
    createdAt: "2026-10-01T10:00:00Z",
    ...over
  };
}

test("lastDepositDay: 30 días después de la fecha de pago", () => {
  assert.equal(lastDepositDay({ payDate: "2026-10-22" }), "2026-11-21");
  assert.equal(lastDepositDay({ payDate: "2026-12-15" }), "2027-01-14");
});

test("dueInfo de cheques recibidos", () => {
  assert.deepEqual(dueInfo(cheque({ payDate: "2026-10-23" }), TODAY), { text: "se puede depositar mañana", tone: "soon" });
  assert.deepEqual(dueInfo(cheque({ payDate: "2026-11-20" }), TODAY), { text: "se puede depositar en 29 días", tone: "ok" });
  assert.deepEqual(dueInfo(cheque({ payDate: "2026-10-01" }), TODAY), { text: "ya se puede depositar (quedan 9 días)", tone: "soon" });
  assert.deepEqual(dueInfo(cheque({ payDate: "2026-09-25" }), TODAY), { text: "ya se puede depositar (quedan 3 días)", tone: "late" });
  assert.deepEqual(dueInfo(cheque({ payDate: "2026-09-22" }), TODAY), { text: "depositalo hoy: es el último día", tone: "late" });
  assert.deepEqual(dueInfo(cheque({ payDate: "2026-09-01" }), TODAY), { text: "venció el plazo para depositarlo", tone: "late" });
  assert.equal(dueInfo(cheque({ status: "deposited" }), TODAY), null);
});

test("dueInfo de cheques propios", () => {
  const own = (payDate: string) => cheque({ kind: "issued", status: "pending", payDate });
  assert.deepEqual(dueInfo(own("2026-10-22"), TODAY), { text: "se debita hoy", tone: "late" });
  assert.deepEqual(dueInfo(own("2026-10-20"), TODAY), { text: "se tenía que debitar hace 2 días", tone: "late" });
  assert.deepEqual(dueInfo(own("2026-10-27"), TODAY), { text: "se debita en 5 días", tone: "soon" });
  assert.deepEqual(dueInfo(own("2026-12-01"), TODAY), { text: "se debita en 40 días", tone: "ok" });
});

test("chequeAlerts", () => {
  const list = [
    cheque({ amount: 100, payDate: "2026-10-25" }),
    cheque({ amount: 200, payDate: "2026-09-25" }),
    cheque({ amount: 400, payDate: "2026-11-15" }),
    cheque({ amount: 800, payDate: "2026-10-01", status: "deposited" }),
    cheque({ kind: "issued", status: "pending", amount: 50, payDate: "2026-10-28" }),
    cheque({ kind: "issued", status: "pending", amount: 70, payDate: "2026-11-28" }),
    cheque({ kind: "issued", status: "debited", amount: 90, payDate: "2026-10-21" })
  ];
  assert.deepEqual(chequeAlerts(list, TODAY), {
    toDeposit: { count: 2, total: 300 },
    expiring: { count: 1, total: 200 },
    toDebit: { count: 1, total: 50 }
  });
});

test("sortCheques: abiertos por fecha y después el historial", () => {
  const a = cheque({ id: "a", payDate: "2026-11-01" });
  const b = cheque({ id: "b", payDate: "2026-10-25" });
  const c = cheque({ id: "c", status: "deposited", stepDate: "2026-10-20" });
  const d = cheque({ id: "d", status: "rejected", stepDate: "2026-10-21" });
  assert.deepEqual(sortCheques([a, c, b, d]).map((x) => x.id), ["b", "a", "d", "c"]);
});

test("undoLabel y validateChequeInput", () => {
  assert.equal(undoLabel({ status: "in_portfolio" }), "Borrar cheque");
  assert.equal(undoLabel({ status: "deposited" }), "Deshacer depósito");
  assert.equal(validateChequeInput({ number: " ", amount: 1, payDate: TODAY }), "Poné el número del cheque.");
  assert.equal(validateChequeInput({ number: "1", amount: 0, payDate: TODAY }), "Poné el monto del cheque.");
  assert.equal(validateChequeInput({ number: "1", amount: 1, payDate: "" }), "Poné la fecha de cobro del cheque.");
  assert.equal(validateChequeInput({ number: "1", amount: 1, payDate: TODAY, cuit: "20-1234" }), "El CUIT tiene que tener 11 números.");
  assert.equal(validateChequeInput({ number: "1", amount: 1, payDate: TODAY, cuit: "20-12345678-3" }), null);
});
