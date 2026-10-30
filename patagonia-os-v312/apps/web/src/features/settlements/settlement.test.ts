import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addBusinessDays, cardFeeMonths, feeLooksWrong, settle, upcomingByDay, type SettleAccount } from "./settlement";

const posnet: SettleAccount = { id: "pos", name: "Posnet", days: 2, feePct: 3, reconId: "prov", isCard: true };
const transfer: SettleAccount = { id: "tr", name: "Transferencia", days: 0, feePct: 0, reconId: "prov", isCard: false };
const mp: SettleAccount = { id: "mp", name: "Mercado Pago", days: 1, feePct: 6, reconId: null, isCard: false };

describe("addBusinessDays", () => {
  it("salta fines de semana y feriados", () => {
    assert.equal(addBusinessDays("2026-10-09", 0), "2026-10-09");
    // viernes 9 + 1 hábil: el lunes 12 es feriado → martes 13
    assert.equal(addBusinessDays("2026-10-09", 1), "2026-10-13");
    // sábado + 1 → lunes
    assert.equal(addBusinessDays("2026-10-17", 1), "2026-10-19");
    assert.equal(addBusinessDays("2026-10-01", 2), "2026-10-05");
  });
});

describe("settle", () => {
  it("transferencias: lo pendiente es lo que no se cruzó con el banco", () => {
    const [r] = settle({
      accounts: [transfer],
      sales: [
        { accountId: "tr", date: "2026-10-01", gross: 1000, grossMatched: 600 },
        { accountId: "tr", date: "2026-10-02", gross: 500, grossMatched: 500 },
        { accountId: "tr", date: "2026-10-20", gross: 300, grossMatched: 0 }
      ],
      cardCredits: [],
      coverage: [{ reconId: "prov", firstDate: "2026-10-01", lastDate: "2026-10-21" }],
      today: "2026-10-22"
    });
    assert.deepEqual(r.lots.map((l) => [l.saleDate, l.status, l.pendingGross]), [
      ["2026-10-01", "atrasado", 400],
      ["2026-10-02", "entro", 0],
      ["2026-10-20", "por_entrar", 300]
    ]);
    assert.equal(r.pendingGross, 700);
    assert.equal(r.lateGross, 400);
  });

  it("posnet: las acreditaciones cubren los lotes del más viejo al más nuevo", () => {
    const input = {
      accounts: [posnet],
      sales: [
        { accountId: "pos", date: "2026-10-01", gross: 1000, grossMatched: 0 },
        { accountId: "pos", date: "2026-10-02", gross: 1000, grossMatched: 0 }
      ],
      cardCredits: [{ reconId: "prov", date: "2026-10-05", amount: 970 }],
      today: "2026-10-06"
    };
    const [r] = settle({ ...input, coverage: [{ reconId: "prov", firstDate: "2026-10-01", lastDate: "2026-10-06" }] });
    assert.deepEqual(r.lots.map((l) => [l.expectedDate, l.status, l.pendingGross, l.pendingNet]), [
      ["2026-10-05", "entro", 0, 0],
      ["2026-10-06", "por_entrar", 1000, 970]
    ]);
    // Si el resumen ya llega al 20 y no apareció, está atrasado.
    const [late] = settle({ ...input, coverage: [{ reconId: "prov", firstDate: "2026-10-01", lastDate: "2026-10-20" }] });
    assert.equal(late.lots[1].status, "atrasado");
  });

  it("posnet: un lote cubierto a medias queda con lo que falta", () => {
    const [r] = settle({
      accounts: [posnet],
      sales: [{ accountId: "pos", date: "2026-10-01", gross: 1000, grossMatched: 0 }],
      cardCredits: [{ reconId: "prov", date: "2026-10-05", amount: 485 }],
      coverage: [{ reconId: "prov", firstDate: "2026-10-01", lastDate: "2026-10-05" }],
      today: "2026-10-06"
    });
    assert.equal(r.lots[0].pendingGross, 500);
    assert.equal(r.lots[0].pendingNet, 485);
  });

  it("sin resumen: se supone que entró el día previsto", () => {
    const [r] = settle({
      accounts: [mp],
      sales: [
        { accountId: "mp", date: "2026-10-20", gross: 1000, grossMatched: 0 },
        { accountId: "mp", date: "2026-10-22", gross: 2000, grossMatched: 0 }
      ],
      cardCredits: [],
      coverage: [],
      today: "2026-10-22"
    });
    assert.deepEqual(r.lots.map((l) => [l.status, l.assumed]), [["entro", true], ["por_entrar", true]]);
    assert.equal(r.pendingGross, 2000);
    assert.equal(r.pendingNet, 1880);
  });

  it("lo vendido antes del primer resumen no se marca como atrasado", () => {
    const [r] = settle({
      accounts: [transfer],
      sales: [{ accountId: "tr", date: "2026-09-10", gross: 1000, grossMatched: 0 }],
      cardCredits: [],
      coverage: [{ reconId: "prov", firstDate: "2026-10-01", lastDate: "2026-10-21" }],
      today: "2026-10-22"
    });
    assert.equal(r.lots[0].status, "entro");
    assert.equal(r.pendingGross, 0);
  });

  it("mide la comisión real y avisa si el % cargado no es el real", () => {
    const sales = [];
    for (let d = 1; d <= 28; d++) sales.push({ accountId: "pos", date: `2026-09-${String(d).padStart(2, "0")}`, gross: 1000, grossMatched: 0 });
    const [r] = settle({
      accounts: [posnet],
      sales,
      cardCredits: [{ reconId: "prov", date: "2026-09-30", amount: 26600 }],
      coverage: [{ reconId: "prov", firstDate: "2026-09-01", lastDate: "2026-09-30" }],
      today: "2026-10-01"
    });
    // los 28 días vendidos tenían que entrar en septiembre (28.000) y entraron 26.600: 5%
    assert.equal(r.realFeePct, 5);
    assert.equal(feeLooksWrong(r), true);
  });
});

describe("upcomingByDay", () => {
  it("suma por día y lo previsto para antes de hoy lo muestra hoy", () => {
    const res = settle({
      accounts: [mp],
      sales: [
        { accountId: "mp", date: "2026-10-22", gross: 1000, grossMatched: 0 },
        { accountId: "mp", date: "2026-10-23", gross: 1000, grossMatched: 0 }
      ],
      cardCredits: [],
      coverage: [],
      today: "2026-10-22"
    });
    assert.deepEqual(upcomingByDay(res, "2026-10-22"), [
      { date: "2026-10-23", net: 940, gross: 1000 },
      { date: "2026-10-26", net: 940, gross: 1000 }
    ]);
  });
});

describe("cardFeeMonths", () => {
  it("solo meses terminados y cubiertos de punta a punta", () => {
    const months = cardFeeMonths({
      accounts: [posnet],
      sales: [
        { accountId: "pos", date: "2026-09-10", gross: 10000, grossMatched: 0 },
        { accountId: "pos", date: "2026-10-10", gross: 10000, grossMatched: 0 }
      ],
      cardCredits: [
        { reconId: "prov", date: "2026-09-14", amount: 9600 },
        { reconId: "prov", date: "2026-10-14", amount: 9600 }
      ],
      coverage: [{ reconId: "prov", firstDate: "2026-09-01", lastDate: "2026-10-20" }],
      today: "2026-10-22"
    });
    assert.deepEqual(months, [{ reconId: "prov", month: "2026-09", expected: 10000, credited: 9600, fee: 400, feePct: 4 }]);
  });
});
