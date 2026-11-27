import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkUpdateOffer,
  compareVersions,
  verifyInstaller,
  createSignedManifest,
  keyIdOf,
  loadPrivateKey,
  signedBytes,
  validateManifest,
  verifyManifest,
} from "./update-manifest.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const fields = {
  version: "0.2.0",
  channel: "piloto",
  minVersion: "0.1.0",
  url: "https://patagoniasystem.com.ar/descargas/PatagoniaScaleConnect-Setup-0.2.0.exe",
  sha256: "a".repeat(64),
  size: 12_345_678,
  publishedAt: "2026-11-27T12:00:00.000Z",
};

test("formato: tiene exactamente los campos acordados", () => {
  const m = createSignedManifest(fields, privateKey);
  assert.deepEqual(Object.keys(m).sort(), [
    "channel", "keyId", "minVersion", "product", "publishedAt", "schema", "sha256", "signature", "size", "url", "version",
  ]);
  assert.equal(m.schema, 1);
  assert.equal(m.product, "patagonia-scale-connect");
  assert.equal(m.keyId, keyIdOf(publicKey));
  assert.match(m.keyId, /^[0-9a-f]{16}$/);
  assert.equal(Buffer.from(m.signature, "base64").length, 64);
  assert.deepEqual(validateManifest(m), []);
});

test("la firma verifica con la clave pública", () => {
  const m = createSignedManifest(fields, privateKey);
  assert.deepEqual(verifyManifest(m, publicKey), { ok: true });
  // Reordenar y reformatear el JSON no rompe la firma.
  const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(m).reverse()), null, 4));
  assert.deepEqual(verifyManifest(reordered, publicKey), { ok: true });
});

test("cualquier cambio de valor invalida la firma", () => {
  const m = createSignedManifest(fields, privateKey);
  for (const [key, value] of [
    ["version", "0.2.1"],
    ["channel", "general"],
    ["minVersion", "0.0.1"],
    ["url", "https://otro.example.com/x.exe"],
    ["sha256", "b".repeat(64)],
    ["size", 1],
    ["publishedAt", "2026-11-28T12:00:00.000Z"],
  ]) {
    const result = verifyManifest({ ...m, [key]: value }, publicKey);
    assert.equal(result.ok, false, `cambiar ${key} debería invalidar`);
  }
});

test("otra clave no verifica", () => {
  const m = createSignedManifest(fields, privateKey);
  const other = generateKeyPairSync("ed25519");
  assert.match(verifyManifest(m, other.publicKey).reason, /otra clave/);
  // Aunque se falsifique el keyId, la firma no cierra.
  const forged = { ...m, keyId: keyIdOf(other.publicKey) };
  assert.match(verifyManifest(forged, other.publicKey).reason, /no coincide/);
});

test("sin firma o con firma rota no verifica", () => {
  const m = createSignedManifest(fields, privateKey);
  const { signature, ...unsigned } = m;
  assert.equal(verifyManifest(unsigned, publicKey).ok, false);
  assert.equal(verifyManifest({ ...m, signature: Buffer.alloc(64).toString("base64") }, publicKey).ok, false);
  assert.equal(verifyManifest({ ...m, signature: "corta" }, publicKey).ok, false);
  assert.ok(signature);
});

test("lo firmado lleva prefijo de dominio y JSON canónico", () => {
  const m = createSignedManifest(fields, privateKey);
  const text = signedBytes(m).toString("utf8");
  assert.ok(text.startsWith("patagonia-scale-connect/update-manifest/v1\n{\"channel\":"));
  assert.ok(!text.includes("signature"));
});

test("rechaza campos inválidos al armar", () => {
  assert.throws(() => createSignedManifest({ ...fields, url: "http://inseguro/x.exe" }, privateKey), /https/);
  assert.throws(() => createSignedManifest({ ...fields, channel: "beta" }, privateKey), /channel/);
  assert.throws(() => createSignedManifest({ ...fields, sha256: "xyz" }, privateKey), /sha256/);
  assert.throws(() => createSignedManifest({ ...fields, minVersion: "0.3.0" }, privateKey), /minVersion/);
  assert.throws(() => createSignedManifest({ ...fields, version: "dos" }, privateKey), /version/);
  assert.deepEqual(validateManifest({ ...createSignedManifest(fields, privateKey), extra: 1 }), ["Campo desconocido: extra"]);
});

test("anti-bajada: un manifiesto viejo firmado de verdad no hace bajar ni reinstalar la misma versión", () => {
  const m = createSignedManifest(fields, privateKey); // 0.2.0, piloto, minVersion 0.1.0
  const now = new Date("2026-11-27T13:00:00.000Z");
  assert.deepEqual(checkUpdateOffer(m, publicKey, { currentVersion: "0.1.5", channel: "piloto", now }), { ok: true });
  assert.match(checkUpdateOffer(m, publicKey, { currentVersion: "0.2.0", channel: "piloto", now }).reason, /nunca se baja/);
  assert.match(checkUpdateOffer(m, publicKey, { currentVersion: "0.3.0", channel: "piloto", now }).reason, /nunca se baja/);
  assert.match(checkUpdateOffer(m, publicKey, { currentVersion: "0.10.0", channel: "piloto", now }).reason, /nunca se baja/);
});

test("ofertas: canal, minVersion, fecha y firma", () => {
  const m = createSignedManifest(fields, privateKey);
  const now = new Date("2026-11-27T13:00:00.000Z");
  assert.match(checkUpdateOffer(m, publicKey, { currentVersion: "0.1.5", channel: "general", now }).reason, /canal piloto/);
  assert.equal(checkUpdateOffer(m, publicKey, { currentVersion: "0.1.5", channel: "interno", now }).ok, true);
  assert.equal(checkUpdateOffer(m, publicKey, { currentVersion: "0.1.5", channel: "raro", now }).ok, false);
  const strict = createSignedManifest({ ...fields, minVersion: "0.1.5" }, privateKey);
  assert.match(checkUpdateOffer(strict, publicKey, { currentVersion: "0.1.0", channel: "piloto", now }).reason, /reinstalar/);
  const future = createSignedManifest({ ...fields, publishedAt: "2027-01-01T00:00:00.000Z" }, privateKey);
  assert.match(checkUpdateOffer(future, publicKey, { currentVersion: "0.1.5", channel: "piloto", now }).reason, /futuro/);
  // Cambiar la versión de un manifiesto viejo para "subirla" rompe la firma.
  assert.match(checkUpdateOffer({ ...m, version: "9.9.9" }, publicKey, { currentVersion: "0.2.0", channel: "piloto", now }).reason, /no coincide/);
  assert.equal(checkUpdateOffer(m, publicKey, { currentVersion: "x", channel: "piloto", now }).ok, false);
});

test("el instalador bajado tiene que ser exactamente el del manifiesto", () => {
  const data = Buffer.from("instalador de prueba");
  const m = createSignedManifest({ ...fields, sha256: createHash("sha256").update(data).digest("hex"), size: data.length }, privateKey);
  assert.deepEqual(verifyInstaller(data, m), { ok: true });
  assert.match(verifyInstaller(Buffer.from("instalador de pruebX"), m).reason, /SHA-256/);
  assert.match(verifyInstaller(Buffer.concat([data, Buffer.from("!")]), m).reason, /Pesa/);
});

test("compareVersions", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
});

test("loadPrivateKey acepta PEM y DER en base64, y rechaza otras curvas", () => {
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  const b64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  assert.equal(keyIdOf(loadPrivateKey(pem)), keyIdOf(publicKey));
  assert.equal(keyIdOf(loadPrivateKey(b64)), keyIdOf(publicKey));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" });
  assert.throws(() => loadPrivateKey(rsa), /ed25519/);
  assert.throws(() => loadPrivateKey(""), /Falta/);
});

test("CLI: firma con la clave de la variable de entorno y verifica", () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "make-update-manifest.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "scale-manifest-"));
  try {
    const installer = path.join(dir, "Setup.exe");
    writeFileSync(installer, "instalador de prueba");
    const out = path.join(dir, "latest.json");
    const env = { ...process.env, SCALE_CONNECT_UPDATE_KEY: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
    execFileSync(process.execPath, [script, "--url", fields.url, "--file", installer, "--channel", "general", "--version", "0.2.0", "--out", out], { env });
    const m = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(m.size, Buffer.byteLength("instalador de prueba"));
    assert.equal(m.channel, "general");
    assert.deepEqual(verifyManifest(m, publicKey), { ok: true });

    const pub = path.join(dir, "pub.pem");
    writeFileSync(pub, publicKey.export({ format: "pem", type: "spki" }));
    assert.match(execFileSync(process.execPath, [script, "verify", "--manifest", out, "--public-key", pub], { encoding: "utf8" }), /Firma válida/);

    // Sin la variable de entorno no firma.
    const { SCALE_CONNECT_UPDATE_KEY, ...noKey } = env;
    assert.ok(SCALE_CONNECT_UPDATE_KEY);
    assert.throws(() => execFileSync(process.execPath, [script, "--url", fields.url, "--file", installer, "--out", out], { env: noKey, stdio: "pipe" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
