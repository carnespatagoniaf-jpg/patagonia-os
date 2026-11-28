import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectorStatus, countdownText, formatCode, newlyPaired, parseConnectors, parsePairingCode, secondsLeft, sortConnectors, type ScaleConnector } from "./scale-connect-logic";

const NOW = new Date("2026-11-27T15:00:00Z");

const row = (over: Partial<ScaleConnector> = {}): ScaleConnector => ({
  id: "c1",
  name: "Caja 1",
  branchId: "b1",
  branchName: "Centro",
  version: "0.2.0",
  status: "active",
  lastSeenAt: "2026-11-27T14:59:30Z",
  online: true,
  scales: [],
  pairedAt: "2026-11-27T10:00:00Z",
  revokedAt: null,
  ...over,
});

describe("Computadoras con Scale Connect", () => {
  it("lee la lista de la base y descarta lo raro", () => {
    const list = parseConnectors([
      { id: "c1", name: "Caja 1", branch_id: "b1", branch_name: "Centro", version: "0.2.0", status: "active", last_seen_at: "x", online: true, scales: [{ key: "kretz-1", name: "Report", online: true }, { name: "sin key" }], paired_at: "p", revoked_at: null },
      { name: "sin id" },
      "texto",
      { id: "c2", status: "revoked" },
    ]);
    assert.equal(list.length, 2);
    assert.deepEqual(list[0].scales, [{ key: "kretz-1", name: "Report", online: true }]);
    assert.equal(list[1].status, "revoked");
    assert.equal(list[1].online, false);
    assert.deepEqual(parseConnectors(null), []);
  });

  it("código: formato y cuenta regresiva", () => {
    assert.deepEqual(parsePairingCode({ code: "ABCDEFGH", expires_at: "2026-11-27T15:10:00Z", branch_id: "b1" }), { code: "ABCDEFGH", expiresAt: "2026-11-27T15:10:00Z", branchId: "b1" });
    assert.equal(parsePairingCode({ code: "ABCDEFGH" }), null);
    assert.equal(formatCode("abcdefgh"), "ABCD-EFGH");
    assert.equal(secondsLeft("2026-11-27T15:10:00Z", NOW), 600);
    assert.equal(secondsLeft("2026-11-27T14:00:00Z", NOW), 0);
    assert.equal(countdownText(600), "Vence en 10:00");
    assert.equal(countdownText(65), "Vence en 1:05");
    assert.equal(countdownText(0), "El código venció. Pedí otro.");
  });

  it("estado según el latido", () => {
    assert.deepEqual(connectorStatus(row(), NOW), { text: "En línea", tone: "ok" });
    assert.deepEqual(connectorStatus(row({ online: false, lastSeenAt: "2026-11-27T12:00:00Z" }), NOW), { text: "Sin conexión desde hace 3 horas", tone: "warn" });
    assert.deepEqual(connectorStatus(row({ online: false, lastSeenAt: "2026-11-27T14:50:00Z" }), NOW), { text: "Sin conexión desde hace 10 minutos", tone: "warn" });
    assert.deepEqual(connectorStatus(row({ online: false, lastSeenAt: "2026-11-25T15:00:00Z" }), NOW), { text: "Sin conexión desde hace 2 días", tone: "warn" });
    assert.deepEqual(connectorStatus(row({ online: false, lastSeenAt: null }), NOW), { text: "Todavía no se conectó", tone: "warn" });
    assert.deepEqual(connectorStatus(row({ status: "revoked", online: true }), NOW), { text: "Desvinculada", tone: "muted" });
  });

  it("avisa cuando aparece una PC nueva o se recupera una (cambia paired_at)", () => {
    const before = [row()];
    assert.equal(newlyPaired(before, [row()]), null);
    assert.equal(newlyPaired(before, [row(), row({ id: "c2", name: "Caja 2" })])?.name, "Caja 2");
    assert.equal(newlyPaired(before, [row({ pairedAt: "2026-11-27T15:00:00Z" })])?.id, "c1");
    assert.equal(newlyPaired(before, [row(), row({ id: "c3", status: "revoked" })]), null);
  });

  it("activas primero, por nombre", () => {
    const sorted = sortConnectors([row({ id: "a", name: "Caja 2" }), row({ id: "b", name: "Bodega", status: "revoked" }), row({ id: "c", name: "Caja 1" })]);
    assert.deepEqual(sorted.map((c) => c.id), ["c", "a", "b"]);
  });
});
