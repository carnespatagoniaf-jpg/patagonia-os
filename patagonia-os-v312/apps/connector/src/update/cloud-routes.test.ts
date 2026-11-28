// Rutas /update y /update-report de la Edge Function scale-connect-api (lógica pura en connect.ts; el resto de
// connect.ts se prueba desde apps/web/src/features/scales/scale-connect-server.test.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { apiRoute, maxBodyFor, MAX_SMALL_BODY, parseUpdateReport, parseUpdateRequest } from "../../../../supabase/functions/scale-connect-api/connect";

test("las rutas de actualización existen y llevan cuerpo chico", () => {
  assert.equal(apiRoute("/functions/v1/scale-connect-api/update"), "update");
  assert.equal(apiRoute("/functions/v1/scale-connect-api/update-report/"), "update-report");
  assert.equal(maxBodyFor("update"), MAX_SMALL_BODY);
  assert.equal(maxBodyFor("update-report"), MAX_SMALL_BODY);
});

test("/update: la versión actual se acota; cualquier otra cosa = la del último latido", () => {
  assert.deepEqual(parseUpdateRequest({ current_version: "0.2.1" }), { ok: true, value: { currentVersion: "0.2.1" } });
  assert.deepEqual(parseUpdateRequest({ current_version: "'; drop table x; --" }), { ok: true, value: { currentVersion: null } });
  assert.deepEqual(parseUpdateRequest(undefined), { ok: true, value: { currentVersion: null } });
  assert.equal(parseUpdateRequest([1]).ok, false);
});

test("/update-report: solo resultados conocidos, versiones válidas y mensaje acotado", () => {
  const ok = parseUpdateReport({ result: "revertida", from: "0.2.1", to: "0.3.0", message: "x".repeat(500), extra: 1 });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && { ...ok.value, message: ok.value.message?.length }, { result: "revertida", from: "0.2.1", to: "0.3.0", message: 300 });
  assert.equal(parseUpdateReport({ result: "hackeada" }).ok, false);
  assert.equal(parseUpdateReport("instalada").ok, false);
  const bad = parseUpdateReport({ result: "instalada", to: "no" });
  assert.ok(bad.ok && bad.value.to === null);
});
