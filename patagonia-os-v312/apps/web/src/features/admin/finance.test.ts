import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { investmentStatus, monthSummary, partnerSplit, type FinAccount, type FinMovement } from "./finance";

const accounts: FinAccount[] = [
  { id: "ars", name: "Banco", currency: "ARS", openingBalance: 0, receivesPayments: true, active: true, balance: 0 },
  { id: "usd", name: "Dólares", currency: "USD", openingBalance: 0, receivesPayments: false, active: true, balance: 0 }
];

function mov(over: Partial<FinMovement>): FinMovement {
  return { id: Math.random().toString(), date: "2026-10-10", accountId: "ars", kind: "gasto", direction: "out", amount: 0, category: null, description: null, partnerId: null, fromInvestment: false, fromPayment: false, transferId: null, recurring: false, ...over };
}

describe("Finanzas de Patagonia", () => {
  it("resultado del mes: ingresos − gastos − sueldos; aportes, retiros y transferencias no cuentan", () => {
    const s = monthSummary(
      [
        mov({ kind: "ingreso", direction: "in", amount: 39000 * 21 }),
        mov({ kind: "gasto", amount: 300000, category: "Publicidad" }),
        mov({ kind: "gasto", amount: 50000, category: "Servidores" }),
        mov({ kind: "gasto", amount: 20000, category: "Servidores" }),
        mov({ kind: "sueldo", amount: 200000, partnerId: "a" }),
        mov({ kind: "aporte", direction: "in", amount: 5000, accountId: "usd", partnerId: "s" }),
        mov({ kind: "transferencia", direction: "in", amount: 1200000 }),
        mov({ kind: "retiro", amount: 10000, partnerId: "a" })
      ],
      accounts
    );
    assert.equal(s.length, 1, "los dólares solo tuvieron un aporte: no hay resultado en USD");
    assert.equal(s[0].income, 819000);
    assert.equal(s[0].expenses, 370000);
    assert.equal(s[0].salaries, 200000);
    assert.equal(s[0].result, 249000);
    assert.deepEqual(s[0].byCategory, [{ category: "Publicidad", amount: 300000 }, { category: "Servidores", amount: 70000 }]);
  });

  it("reparto 75/25 del resultado; con pérdida no le toca nada a nadie", () => {
    const partners = [{ id: "a", name: "Socio A", sharePct: 75 }, { id: "s", name: "Santiago", sharePct: 25 }];
    assert.deepEqual(partnerSplit(249000, partners).map((x) => x.amount), [186750, 62250]);
    assert.deepEqual(partnerSplit(-1000, partners).map((x) => x.amount), [0, 0]);
  });

  it("inversión: lo aportado, lo pagado con esa plata y lo que queda, por moneda (sin mezclar pesos con dólares)", () => {
    const st = investmentStatus({
      investment: [{ currency: "USD", partnerId: "s", contributed: 5000, withdrawn: null, salaries: null }, { currency: "USD", partnerId: "a", contributed: null, withdrawn: 100, salaries: null }],
      investmentSpent: [{ currency: "ARS", amount: 300000 }, { currency: "USD", amount: 1200 }]
    });
    assert.deepEqual(st, [
      { currency: "USD", contributed: 5000, spent: 1200, left: 3800 },
      { currency: "ARS", contributed: 0, spent: 300000, left: -300000 }
    ]);
  });
});
