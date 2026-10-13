import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAmount } from "../../lib/money";
import { buildDeclared, countIsOk, findPaymentSwaps, parseCountResult, type CountResult } from "./cash-close";

const CASH = "acc-efectivo";
const TRANSFER = "acc-transferencia";
const BANCO = "acc-banco2";

function result(over: Partial<CountResult> = {}): CountResult {
  return {
    attempt: 1,
    cashDeclared: 32000,
    cashExpected: 32000,
    cashDifference: 0,
    firstCashDifference: 0,
    openingCash: 32000,
    cashSales: 0,
    cashMovements: 0,
    accounts: [],
    ...over
  };
}

describe("cierre a ciegas: lo que declara la cajera", () => {
  it("exige el efectivo y el total de cada medio (0 vale)", () => {
    assert.deepEqual(buildDeclared({ cash: "", accounts: {} }, [], parseAmount), { error: "Contá la plata del cajón y anotá cuánto hay." });
    const missing = buildDeclared({ cash: "32.000", accounts: { [TRANSFER]: "" } }, [TRANSFER], parseAmount);
    assert.ok("error" in missing);
    const ok = buildDeclared({ cash: "32.000", accounts: { [TRANSFER]: "0", [BANCO]: "459.200,50" } }, [TRANSFER, BANCO], parseAmount);
    assert.deepEqual(ok, {
      payload: { cash: 32000, accounts: [{ account_id: TRANSFER, amount: 0 }, { account_id: BANCO, amount: 459200.5 }] }
    });
  });
});

describe("cierre a ciegas: ¿da bien?", () => {
  it("diferencias de vuelto ($390) dan bien; $99.548 no", () => {
    assert.equal(countIsOk(result({ cashDifference: 390 })), true);
    assert.equal(countIsOk(result({ cashDifference: -99548 })), false);
  });

  it("un medio no informado sin ventas no molesta; con ventas sí", () => {
    const row = { accountId: TRANSFER, name: "Transferencia", paymentMethod: "digital", declared: null, difference: null, salesCount: 0 };
    assert.equal(countIsOk(result({ accounts: [{ ...row, expected: 0 }] })), true);
    assert.equal(countIsOk(result({ accounts: [{ ...row, expected: 5000, salesCount: 1 }] })), false);
  });
});

describe("venta cobrada con el medio de pago equivocado", () => {
  const payments = [
    { saleId: "s1", paymentId: "p1", accountId: TRANSFER, amount: 80857, createdAt: "2026-10-12T12:00:00Z" },
    { saleId: "s2", paymentId: "p2", accountId: TRANSFER, amount: 12000, createdAt: "2026-10-12T12:10:00Z" },
    { saleId: "s3", paymentId: "p3", accountId: CASH, amount: 80857, createdAt: "2026-10-12T12:20:00Z" }
  ];

  it("sobra efectivo y falta transferencia por lo mismo: propone esa venta", () => {
    const r = result({
      cashDifference: 80857,
      accounts: [{ accountId: TRANSFER, name: "Transferencia", paymentMethod: "digital", declared: 283717, expected: 364574, difference: -80857, salesCount: 15 }]
    });
    const swaps = findPaymentSwaps(r, payments, { accountId: CASH, name: "Efectivo" });
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0].fromAccountId, TRANSFER);
    assert.equal(swaps[0].toAccountId, CASH);
    assert.deepEqual(swaps[0].candidates.map((c) => c.paymentId), ["p1"]);
  });

  it("al revés: transferencia cobrada y marcada como efectivo", () => {
    const r = result({
      cashDifference: -80857,
      accounts: [{ accountId: TRANSFER, name: "Transferencia", paymentMethod: "digital", declared: 445431, expected: 364574, difference: 80857, salesCount: 15 }]
    });
    const swaps = findPaymentSwaps(r, payments, { accountId: CASH, name: "Efectivo" });
    assert.equal(swaps[0].fromAccountId, CASH);
    assert.deepEqual(swaps[0].candidates.map((c) => c.paymentId), ["p3"]);
  });

  it("solo falta efectivo (los otros medios dan justo): no hay excusa de medio de pago", () => {
    const r = result({
      cashDifference: -99548,
      accounts: [{ accountId: TRANSFER, name: "Transferencia", paymentMethod: "digital", declared: 364574, expected: 364574, difference: 0, salesCount: 15 }]
    });
    assert.deepEqual(findPaymentSwaps(r, payments, { accountId: CASH, name: "Efectivo" }), []);
  });

  it("montos que no se compensan no se proponen", () => {
    const r = result({
      cashDifference: 10000,
      accounts: [{ accountId: TRANSFER, name: "Transferencia", paymentMethod: "digital", declared: 0, expected: 80857, difference: -80857, salesCount: 1 }]
    });
    assert.deepEqual(findPaymentSwaps(r, payments, { accountId: CASH, name: "Efectivo" }), []);
  });
});

describe("respuesta del servidor", () => {
  it("convierte números y deja null lo no informado", () => {
    const r = parseCountResult({
      attempt: 2, cash_declared: "6400.00", cash_expected: "6400.00", cash_difference: "0.00", first_cash_difference: "5000.00",
      opening_cash: 1000, cash_sales: 7000, cash_movements: -1600,
      accounts: [{ account_id: "a", name: "Banco", payment_method: "transfer", declared: null, expected: "0", difference: null, sales_count: 0 }]
    });
    assert.equal(r.firstCashDifference, 5000);
    assert.equal(r.accounts[0].declared, null);
    assert.equal(r.accounts[0].expected, 0);
  });
});
