import test from "node:test";
import assert from "node:assert/strict";
import { CloudClient, CloudError, isSafeCloudUrl, parseJob } from "./cloud-client";
import { FakeCloud } from "./test-fake-cloud";

const FP = "f".repeat(64);

test("solo https (o esta misma PC): el secreto nunca viaja sin cifrar", () => {
  assert.equal(isSafeCloudUrl("https://abc.supabase.co/functions/v1"), true);
  assert.equal(isSafeCloudUrl("http://127.0.0.1:5000/functions/v1"), true);
  assert.equal(isSafeCloudUrl("http://abc.supabase.co/functions/v1"), false);
  assert.equal(isSafeCloudUrl("https://user:pass@abc.supabase.co"), false);
  assert.equal(isSafeCloudUrl("no es url"), false);
  assert.throws(() => new CloudClient({ baseUrl: "http://evil.com" }), /https/);
});

test("formato del trabajo", () => {
  assert.deepEqual(parseJob({ id: "j", kind: "send", scale_key: "k", payload: { products: [] }, branch_id: "b", requested: 2, queued_at: "x" }), {
    id: "j",
    kind: "send",
    scaleKey: "k",
    branchId: "b",
    requested: 2,
    payload: { products: [] },
    queuedAt: "x",
  });
  assert.equal(parseJob({ id: "j", kind: "borrar", scale_key: "k" }), null);
  assert.equal(parseJob(null), null);
});

test("vincular, latido, tomar, avance, cierre y configuración contra la nube simulada", async (t) => {
  const cloud = new FakeCloud();
  await cloud.start();
  t.after(() => cloud.stop());
  const client = new CloudClient({ baseUrl: cloud.baseUrl });

  assert.deepEqual(await client.pair({ code: "ZZZZ-ZZZZ", name: "Caja 1", fingerprint: FP, version: "1" }), { kind: "error", error: "codigo_invalido" });
  cloud.addCode("ABCDEFGH");
  const paired = await client.pair({ code: "abcd-efgh", name: "Caja 1", fingerprint: FP, version: "1" });
  assert.equal(paired.kind, "paired");
  if (paired.kind !== "paired") return;
  assert.match(paired.secret, /^[A-Za-z0-9_-]{43}$/);
  const cred = { connectorId: paired.connectorId, secret: paired.secret };

  // Reinstalación: misma huella → hay que elegir.
  cloud.addCode("JKLMNPQR");
  const choose = await client.pair({ code: "JKLMNPQR", name: "Otra", fingerprint: FP, version: "1" });
  assert.deepEqual(choose, { kind: "choose", candidates: [{ id: paired.connectorId, name: "Caja 1", lastSeenAt: null }] });

  const hb = await client.heartbeat(cred, { version: "1", scales: [{ key: "kretz-1", name: "Report", online: true }] });
  assert.deepEqual(hb, { name: "Caja 1", branchId: "b1", queued: 0 });
  assert.equal(await client.claim(cred, 1), null);

  const queued = cloud.queueJob({ scaleKey: "kretz-1", payload: { products: [{ plu: "1" }] } });
  const job = await client.claim(cred, 0);
  assert.equal(job?.id, queued.id);
  assert.deepEqual(await client.progress(cred, { jobId: queued.id, seq: 1, done: 1, total: 1, items: [{ plu: "1", action: "write", status: "confirmed" }] }), { duplicate: false });
  assert.deepEqual(await client.progress(cred, { jobId: queued.id, seq: 1, done: 1, total: 1, items: [] }), { duplicate: true });
  await client.finish(cred, { jobId: queued.id, status: "done", items: [] });
  assert.equal(queued.status, "done");
  await assert.rejects(client.finish(cred, { jobId: queued.id, status: "done", items: [] }), (e: CloudError) => e.kind === "conflict");

  const config = await client.config(cred);
  assert.equal(config.companyName, "Carnicería A");
  assert.equal(config.scales[0].key, "kretz-1");

  // Errores clasificados.
  await assert.rejects(client.heartbeat({ ...cred, secret: "x".repeat(43) }, { version: "1", scales: [] }), (e: CloudError) => e.kind === "unauthorized" && e.needsPairing);
  cloud.revoke(paired.connectorId);
  await assert.rejects(client.claim(cred, 0), (e: CloudError) => e.kind === "revoked" && e.needsPairing);
  cloud.mode = "error503";
  await assert.rejects(client.config(cred), (e: CloudError) => e.kind === "server" && !e.needsPairing);
  cloud.mode = "down";
  await assert.rejects(client.config(cred), (e: CloudError) => e.kind === "network");
});
