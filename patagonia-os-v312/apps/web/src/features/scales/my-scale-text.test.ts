import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brandAndModel, lastSendText, sendSummary } from "./my-scale-text";

/** Textos simples de "Mis balanzas" (pedido del dueño: conectar y enviar tiene que ser SENCILLO). */

const now = new Date("2026-11-27T15:00:00-03:00");
const base = { ready: 0, verified: 0, failed: 0, skipped: 0, toReview: 0, occupied: 0 };
const NO_TECH = /\bCOM\d*\b|baud|protocolo|puerto/i;

describe("resultado de un envío", () => {
  it("todo bien: X de Y comprobados y cómo probar la venta", () => {
    const s = sendSummary({ ...base, ready: 30, verified: 10 });
    assert.equal(s.headline, "40 de 40 productos quedaron y se comprobaron en la balanza.");
    assert.equal(s.allOk, true);
    assert.match(s.next[0], /escaneala en Mostrador/);
  });

  it("con problemas: cuántos quedaron y qué hacer con cada grupo", () => {
    const s = sendSummary({ ready: 5, verified: 30, failed: 2, skipped: 3, toReview: 4, occupied: 1 });
    assert.equal(s.headline, "35 de 40 productos quedaron y se comprobaron en la balanza.");
    assert.equal(s.allOk, false);
    assert.equal(s.next.length, 4);
    assert.match(s.next[0], /^2 no quedaron bien: .*Stock.*Enviar de nuevo/);
    assert.match(s.next[1], /^3 productos no van a la balanza/);
    assert.match(s.next[2], /^1 número de la balanza tiene otro producto/);
    assert.match(s.next[3], /^4 productos de la balanza para revisar/);
    for (const t of [s.headline, ...s.next]) assert.doesNotMatch(t, NO_TECH, t);
  });

  it("singular y nada para enviar", () => {
    assert.equal(sendSummary({ ...base, verified: 1 }).headline, "1 de 1 producto quedó y se comprobó en la balanza.");
    assert.equal(sendSummary({ ...base, failed: 1 }).next[0].startsWith("1 no quedó bien"), true);
    assert.equal(sendSummary(base).headline, "No había productos para enviar a la balanza.");
    assert.equal(sendSummary(base).allOk, false);
  });
});

describe("tarjeta de cada balanza", () => {
  it("marca y modelo sin repetir la marca", () => {
    assert.equal(brandAndModel({ family: "kretz", model: "Report" }), "Kretz Report");
    assert.equal(brandAndModel({ family: "systel", model: "Systel Cuora Max" }), "Systel Cuora Max");
    assert.equal(brandAndModel({ family: "kretz", model: null }), "Kretz");
  });

  it("último envío", () => {
    assert.equal(lastSendText({ sentAt: "2026-11-27T10:15:00-03:00", verifiedCount: 40 }, now), "Último envío: hoy 10:15 (40 productos)");
    assert.equal(lastSendText({ sentAt: "2026-11-20T13:00:00-03:00", sentCount: 1 }, now), "Último envío: el 20/11 13:00 (1 producto)");
    assert.equal(lastSendText({}, now), "Todavía no se le enviaron productos");
    assert.equal(lastSendText({ sentAt: "cualquier cosa" }, now), "Todavía no se le enviaron productos");
    assert.equal(lastSendText(null, now), "Todavía no se le enviaron productos");
  });
});
