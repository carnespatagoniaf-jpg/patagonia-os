import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PRECIOS_BALANZA, PLUS_BALANZA } from "../inventory/systel/systel-real-los-gringos";
import { REAL_REPORT_1310 } from "../inventory/systel/systel-real-report-1310";
import { groupTickets, parseSalesReport } from "../inventory/systel/systel-sales";
import { settleTicket, type ScalePrices } from "./systel-ticket-settle";

const prices = new Map<number, ScalePrices>(PRECIOS_BALANZA.split(";").map((r) => {
  const [n, p1, p2] = r.split("|").map(Number);
  return [n, { p1, p2 }];
}));
const weighed = new Set(PLUS_BALANZA.split(";").filter((r) => r.split("|")[1] === "P").map((r) => Number(r.split("|")[0])));

describe("[REAL] importe de cada artículo desde el código de cada producto + el TOTAL (Los gringos, tickets del 13/10)", () => {
  const tickets = groupTickets(parseSalesReport(REAL_REPORT_1310).lines);

  it("ticket 3095 de la foto: TROZADITO 0,215 kg + CAJON 1 u. con TOTAL $73.118 → $1.118 y $72.000 (exacto)", () => {
    const r = settleTicket([{ plu: 5, quantity: 0.215 }, { plu: 2, quantity: 1 }], 73118, prices, 2);
    assert.deepEqual(r, { ok: true, method: "exacto", amounts: [1118, 72000], detail: "importe de cada artículo según el precio que usó la balanza" });
  });

  it("todos los tickets del 13/10 con productos conocidos: el importe deducido de cada artículo es el que cobró la balanza", () => {
    let exact = 0;
    let checked = 0;
    const misses: string[] = [];
    for (const t of tickets) {
      if (t.lines.some((l) => !prices.has(l.plu))) continue;
      checked++;
      const lines = t.lines.map((l) => ({ plu: l.plu, quantity: weighed.has(l.plu) ? l.grams / 1000 : l.units }));
      const r = settleTicket(lines, t.total, prices, t.lines.length);
      if (!r.ok) {
        // Sin una única combinación exacta NO se adivina: se piden los importes del papel.
        assert.equal(r.needsPaper, true, `ticket ${t.ticketId}: ${r.reason}`);
        misses.push(`${t.ticketId}:papel`);
        continue;
      }
      assert.equal(r.amounts.reduce((a, b) => a + b, 0), Math.round(t.total), `ticket ${t.ticketId}`);
      if (r.amounts.every((a, i) => Math.abs(a - t.lines[i].amount) <= 1)) exact++;
      else misses.push(`${t.ticketId}:distinto`);
    }
    assert.ok(checked >= 55, `${checked}`);
    // En la semana completa (1.430 artículos) dio 860 de 861; en el 13/10 se exige al menos 95 %.
    assert.ok(exact / checked >= 0.95, `${exact} de ${checked} exactos; no: ${misses.join(" ")}`);
  });

  it("precio manual (ninguna lista explica el total): NO adivina, pide los importes del ticket impreso", () => {
    const r = settleTicket([{ plu: 2, quantity: 1 }, { plu: 2, quantity: 1 }], 144000 - 4000, prices, 2);
    assert.equal(r.ok, false);
    assert.equal((r as { needsPaper?: boolean }).needsPaper, true);
  });

  it("errores claros: cantidad de artículos distinta del TOTAL, producto sin precio en la balanza, sin artículos", () => {
    assert.equal(settleTicket([{ plu: 5, quantity: 0.215 }], 73118, prices, 2).ok, false);
    assert.equal(settleTicket([{ plu: 9999, quantity: 1 }], 100, prices, 1).ok, false);
    assert.equal(settleTicket([], 100, prices, null).ok, false);
  });
});
