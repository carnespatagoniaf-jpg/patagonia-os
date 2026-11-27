// Publicación desde el CI (scripts/publish-release.mjs), contra un Storage simulado. No sube nada de verdad.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { missingSettings, publish, publishSql, storageBase } from "../publish-release.mjs";
import { checkUpdateOffer, loadPublicKey } from "./update-manifest.mjs";

const pair = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const pem = (k, type) => k.export({ format: "pem", type });

function fakeStorage() {
  const objects = new Map();
  const calls = [];
  const doFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
    const pub = url.match(/\/storage\/v1\/object\/public\/scale-connect\/(.+)$/);
    if (pub) return objects.has(pub[1]) ? new Response(objects.get(pub[1])) : new Response("no", { status: 404 });
    const up = url.match(/\/storage\/v1\/object\/scale-connect\/(.+)$/);
    if (up && init.method === "POST") {
      if (objects.has(up[1])) return new Response(JSON.stringify({ error: "Duplicate" }), { status: 409 });
      objects.set(up[1], Buffer.from(init.body));
      return new Response("{}", { status: 200 });
    }
    return new Response("?", { status: 400 });
  };
  return { objects, calls, doFetch };
}

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sc-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "PatagoniaScaleConnect-Setup-0.3.0.exe");
  writeFileSync(file, Buffer.from("instalador falso 0.3.0"));
  return { dir, file };
}

const env = {
  SCALE_CONNECT_UPDATE_KEY: pem(pair.privateKey, "pkcs8"),
  SCALE_CONNECT_UPDATE_PUBKEY: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  SCALE_CONNECT_STORAGE_URL: "https://xyz.supabase.co",
  SCALE_CONNECT_STORAGE_KEY: "clave-de-prueba",
};

test("sin secretos se saltea con aviso y no toca nada", async (t) => {
  const { dir, file } = setup(t);
  const s = fakeStorage();
  const lines = [];
  const r = await publish({ env: { SCALE_CONNECT_STORAGE_URL: "https://x" }, file, version: "0.3.0", outDir: dir, doFetch: s.doFetch, log: (l) => lines.push(l) });
  assert.equal(r.skipped, true);
  assert.match(lines[0], /^::warning::/);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(missingSettings({}).length, 4);
});

test("firma, sube instalador y manifiesto, y una PC con la clave pública lo acepta", async (t) => {
  const { dir, file } = setup(t);
  const s = fakeStorage();
  const r = await publish({ env, file, version: "0.3.0", outDir: dir, doFetch: s.doFetch, log: () => undefined });
  assert.equal(r.skipped, false);
  assert.ok(s.objects.has("0.3.0/PatagoniaScaleConnect-Setup-0.3.0.exe"));
  assert.ok(s.objects.has("0.3.0/latest.json"));
  const manifest = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
  assert.equal(manifest.url, "https://xyz.supabase.co/storage/v1/object/public/scale-connect/0.3.0/PatagoniaScaleConnect-Setup-0.3.0.exe");
  assert.equal(manifest.sha256, createHash("sha256").update(readFileSync(file)).digest("hex"));
  assert.deepEqual(checkUpdateOffer(manifest, loadPublicKey(env.SCALE_CONNECT_UPDATE_PUBKEY), { currentVersion: "0.2.1", channel: "general" }), { ok: true });
  const sql = readFileSync(path.join(dir, "publicar-0.3.0.sql"), "utf8");
  assert.match(sql, /publish_scale_connect_release\('\{.*"version":"0\.3\.0".*\}'::jsonb, 'pilot', 0\)/);
  // La clave privada nunca aparece en lo que queda.
  for (const out of [sql, JSON.stringify(manifest)]) assert.ok(!out.includes("PRIVATE KEY"));
  // El secreto de Storage va solo en los encabezados de subida.
  assert.ok(s.calls.filter((c) => c.method === "POST").every((c) => c.headers["x-upsert"] === "false"));
});

test("si la privada no es la pareja de la pública embebida, se frena antes de subir", async (t) => {
  const { dir, file } = setup(t);
  const s = fakeStorage();
  await assert.rejects(
    publish({ env: { ...env, SCALE_CONNECT_UPDATE_KEY: pem(other.privateKey, "pkcs8") }, file, version: "0.3.0", outDir: dir, doFetch: s.doFetch, log: () => undefined }),
    /no verifica/,
  );
  assert.equal(s.calls.length, 0);
});

test("nunca pisa un instalador ya publicado con otro contenido (sí acepta el mismo)", async (t) => {
  const { dir, file } = setup(t);
  const s = fakeStorage();
  await publish({ env, file, version: "0.3.0", outDir: dir, doFetch: s.doFetch, log: () => undefined });
  // Mismo archivo otra vez (reintento del CI): bien, y reutiliza el latest.json que ya estaba.
  const first = s.objects.get("0.3.0/latest.json").toString();
  const again = await publish({ env, file, version: "0.3.0", outDir: dir, doFetch: s.doFetch, log: () => undefined });
  assert.equal(again.manifest.signature, JSON.parse(first).signature);
  writeFileSync(file, Buffer.from("OTRO binario con la misma versión"));
  await assert.rejects(publish({ env, file, version: "0.3.0", outDir: dir, doFetch: s.doFetch, log: () => undefined }), /no se pisa/);
});

test("storage solo https y el SQL escapa comillas", () => {
  assert.throws(() => storageBase("http://xyz.supabase.co"));
  assert.equal(storageBase("https://xyz.supabase.co/"), "https://xyz.supabase.co");
  assert.match(publishSql({ version: "1.0.0", keyId: "k", url: "https://x/it's" }), /it''s/);
});
