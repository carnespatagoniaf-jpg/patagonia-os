import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TicketCandidate } from "../inventory/systel/systel-ticket-detail";
import { systelTicketSupportReport, withoutAmounts } from "./scale-support-redact";

// C26: el reporte de soporte del detalle de un ticket Systel no lleva importes de las ventas del cliente.
// Ticket REAL de Los gringos (13/10, operación 3095): cajón $72.000 + trozadito 0,215 kg $1.118 = $73.118.
const candidate = {
  key: "systel:20:13/10/26:3095:1:12:55:00:2:1",
  ticket: {
    ticketId: "3095",
    date: "13/10/26",
    firstTime: "12:55:00",
    time: "12:55:10",
    seller: "1",
    total: 73118,
    lines: [
      { ticketId: "3095", date: "13/10/26", time: "12:55:00", seller: "1", plu: 2, sector: "1", units: 1, grams: 0, drained: 0, amount: 72000 },
      { ticketId: "3095", date: "13/10/26", time: "12:55:10", seller: "1", plu: 5, sector: "1", units: 0, grams: 215, drained: 0, amount: 1118 }
    ]
  },
  lines: null,
  problem: "el producto 5 de la balanza no está vinculado ($1.118)"
} as unknown as TicketCandidate;

describe("C26: reporte de soporte del detalle de un ticket Systel, sin importes", () => {
  const rep = systelTicketSupportReport({
    code: "2202000731184",
    result: { ok: true, candidates: [candidate] },
    context: { freshConnection: true, msSinceLastOk: null, address: 20 },
    log: [{ step: "ventas", fn: 72, tx: "14 48 37", rx: "14 48 33 30 39 35 7c 37 32 30 30 30 30 30", rxText: "3095|7200000", ms: 120, result: "ok" }],
    events: [{ t: 1, kind: "rx", detail: "14 bytes $72.000", hex: "14 48 33 30 39 35" }, { t: 2, kind: "abrir", detail: "COM3" }]
  });
  // El código escaneado va (es un código, lo pide soporte), aunque el TOTAL de una Systel trae el importe adentro.
  const all = JSON.stringify(rep).split("2202000731184").join("<codigo>");

  it("no lleva los importes ni las respuestas crudas de la balanza", () => {
    assert.doesNotMatch(all, /72000|72\.000|1118|1\.118|73118|73\.118|7200000/);
    assert.doesNotMatch(all, /3095\|/, "sin el texto de la respuesta de ventas");
    assert.doesNotMatch(all, /"hex"/, "sin los bytes recibidos");
  });

  it("lleva el código escaneado, los productos (N.º) y el resultado de la lectura", () => {
    assert.match(rep.note, /2202000731184/);
    assert.match(rep.note, /OK: 1 ticket/);
    assert.match(rep.logText, /"plus":\[2,5\]/);
    assert.match(rep.logText, /no está vinculado/);
    assert.equal(rep.diagnosticRecord.log[0].fn, 72);
    assert.equal(rep.diagnosticRecord.log[0].rxBytes, 14);
  });

  it("una lectura fallida tampoco manda importes", () => {
    const bad = systelTicketSupportReport({ code: "2202000731184", result: { ok: false, stage: "ticket", reason: "no hay ningún ticket de $73.118 hoy" }, context: null, log: [], events: [] });
    assert.doesNotMatch(JSON.stringify(bad), /73\.118/);
    assert.equal(withoutAmounts("TOTAL $ 1.234,50 y $5"), "TOTAL $… y $…");
  });
});
