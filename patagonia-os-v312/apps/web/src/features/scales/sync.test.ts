import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installFakeLocalStorage } from "./test-fake-storage";

installFakeLocalStorage();

// Import después de instalar el stub -- las funciones de sync.ts leen
// `localStorage` en cada llamada, no al importar el módulo, así que el
// orden acá no es estrictamente necesario, pero se mantiene explícito.
const { clearSyncSession, getSyncSession, prepareSyncSession, runSafeSync, summarizeSyncSession } = await import("./sync");
const { default: crypto } = await import("node:crypto");

import type { ScaleDriver, ScaleSyncableProduct, ScaleWriteResult } from "./types";

const FAKE_PORT = {} as SerialPort;

function product(code: string, name = `Producto ${code}`): ScaleSyncableProduct {
  return { id: code, code, name, unit: "kg", priceRetail: 1000, active: true };
}

function driverWith(writePlu: ScaleDriver["writePlu"]): ScaleDriver {
  return {
    id: "fake-plu",
    brand: "Fake",
    models: ["Fake"],
    status: "certified",
    capabilities: ["writePlu", "bulkSync"],
    identify: async () => ({ matched: true }),
    writePlu
  };
}

describe("prepareSyncSession / summarizeSyncSession", () => {
  it("arranca todo en pending la primera vez", () => {
    const connectionId = crypto.randomUUID();
    const session = prepareSyncSession(connectionId, [product("1"), product("2")]);
    const summary = summarizeSyncSession(session);
    assert.deepEqual(summary, { total: 2, confirmed: 0, uncertain: 0, failed: 0, pending: 2 });
    clearSyncSession(connectionId);
  });

  it("preserva los ya confirmados de una sesión previa y no los vuelve a marcar pending", () => {
    const connectionId = crypto.randomUUID();
    prepareSyncSession(connectionId, [product("1"), product("2")]);
    const stored = getSyncSession(connectionId)!;
    stored.items[0].status = "confirmed";
    // Simula lo que dejaría runSafeSync -- se persiste manualmente acá porque
    // este test solo ejercita prepareSyncSession, no el ciclo completo.
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      `patagonia-scale-sync-session-${connectionId}`,
      JSON.stringify(stored)
    );
    const resumed = prepareSyncSession(connectionId, [product("1"), product("2"), product("3")]);
    const byCode = new Map(resumed.items.map((i) => [i.code, i.status] as const));
    assert.equal(byCode.get("1"), "confirmed");
    assert.equal(byCode.get("2"), "pending");
    assert.equal(byCode.get("3"), "pending");
    clearSyncSession(connectionId);
  });
});

describe("runSafeSync", () => {
  it("mapea confirmed/unconfirmed/failed del driver a confirmed/uncertain/failed", async () => {
    const connectionId = crypto.randomUUID();
    const results: Record<string, ScaleWriteResult["verified"]> = { "1": "confirmed", "2": "unconfirmed", "3": "failed" };
    const driver = driverWith(async (_port, _settings, p) => ({ verified: results[p.code], message: `resultado ${p.code}` }));

    const session = await runSafeSync(driver, FAKE_PORT, {}, connectionId, [product("1"), product("2"), product("3")]);
    const byCode = new Map(session.items.map((i) => [i.code, i.status] as const));
    assert.equal(byCode.get("1"), "confirmed");
    assert.equal(byCode.get("2"), "uncertain");
    assert.equal(byCode.get("3"), "failed");
    clearSyncSession(connectionId);
  });

  it("al reintentar, no vuelve a mandar los ya confirmados (resumible)", async () => {
    const connectionId = crypto.randomUUID();
    const sent: string[] = [];
    const driver = driverWith(async (_port, _settings, p) => {
      sent.push(p.code);
      return p.code === "1" ? { verified: "confirmed" } : { verified: "failed", message: "rechazado" };
    });

    await runSafeSync(driver, FAKE_PORT, {}, connectionId, [product("1"), product("2")]);
    assert.deepEqual(sent, ["1", "2"]);

    sent.length = 0;
    const second = await runSafeSync(driver, FAKE_PORT, {}, connectionId, [product("1"), product("2")]);
    // Solo se reintenta el "2" (falló antes) -- el "1" (confirmado) no se reenvía.
    assert.deepEqual(sent, ["2"]);
    const summary = summarizeSyncSession(second);
    assert.equal(summary.confirmed, 1);
    assert.equal(summary.failed, 1);
    clearSyncSession(connectionId);
  });

  it("un error de conexión en un producto no frena el resto, y queda como failed", async () => {
    const connectionId = crypto.randomUUID();
    const driver = driverWith(async (_port, _settings, p) => {
      if (p.code === "2") throw new Error("Framing error");
      return { verified: "confirmed" };
    });
    const session = await runSafeSync(driver, FAKE_PORT, {}, connectionId, [product("1"), product("2"), product("3")]);
    const byCode = new Map(session.items.map((i) => [i.code, i.status] as const));
    assert.equal(byCode.get("1"), "confirmed");
    assert.equal(byCode.get("2"), "failed");
    assert.equal(byCode.get("3"), "confirmed");
    clearSyncSession(connectionId);
  });
});
