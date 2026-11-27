import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cloudUrlFor, describeCloud, PRODUCTION_CLOUD_URL, setCloudInConfig, STAGING_CLOUD_URL } from "./cloud-targets";
import { loadConfig } from "../config/config";
import { renderForm, renderPaired } from "./pairing-page";

test("/NUBE=: nombres conocidos, https válido, y nada más", () => {
  assert.equal(cloudUrlFor("produccion"), PRODUCTION_CLOUD_URL);
  assert.equal(cloudUrlFor("Producción"), PRODUCTION_CLOUD_URL);
  assert.equal(cloudUrlFor("pruebas"), STAGING_CLOUD_URL);
  assert.equal(cloudUrlFor("staging"), STAGING_CLOUD_URL);
  assert.equal(cloudUrlFor("https://otro.supabase.co/functions/v1/"), "https://otro.supabase.co/functions/v1");
  assert.equal(cloudUrlFor("http://ejemplo.com/functions/v1"), null, "sin cifrar no");
  assert.equal(cloudUrlFor("cualquiera"), null);
});

test("qué sistema es cada dirección", () => {
  assert.equal(describeCloud(PRODUCTION_CLOUD_URL).kind, "produccion");
  assert.equal(describeCloud(`${STAGING_CLOUD_URL}/`).label, "Patagonia System — sistema de PRUEBAS");
  assert.match(describeCloud("https://x.example.com/functions/v1").label, /otra dirección \(x\.example\.com\)/);
});

test("el instalador escribe solo cloud.url y no pisa el resto ni cambia de sistema solo", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scale-connect-nube-"));
  const file = path.join(dir, "config.json");

  // PC nueva: sin config.json, sin /NUBE= → producción.
  assert.deepEqual(await setCloudInConfig(file, PRODUCTION_CLOUD_URL, { ifMissing: true }), { changed: true, url: PRODUCTION_CLOUD_URL, reason: "escrita" });
  assert.equal((await loadConfig(file)).config.cloud.url, PRODUCTION_CLOUD_URL);

  // PC de prueba con balanzas de banco: /NUBE=pruebas cambia la nube y deja las balanzas.
  await writeFile(file, JSON.stringify({ devices: [{ id: "aura", transport: { type: "serial", path: "COM3", baudRate: 9600 } }], cloud: { url: PRODUCTION_CLOUD_URL, heartbeatMs: 20000 } }));
  await setCloudInConfig(file, STAGING_CLOUD_URL);
  const after = JSON.parse(await readFile(file, "utf8"));
  assert.equal(after.cloud.url, STAGING_CLOUD_URL);
  assert.equal(after.cloud.heartbeatMs, 20000);
  assert.equal(after.devices[0].id, "aura");

  // Actualización sin /NUBE=: se queda en pruebas.
  assert.equal((await setCloudInConfig(file, PRODUCTION_CLOUD_URL, { ifMissing: true })).reason, "se_mantiene");
  assert.equal(JSON.parse(await readFile(file, "utf8")).cloud.url, STAGING_CLOUD_URL);
  await assert.rejects(setCloudInConfig(file, "http://afuera.com/x"));
});

test("/vincular dice a qué sistema se vincula", () => {
  const prod = renderForm({ csrf: "t", target: describeCloud(PRODUCTION_CLOUD_URL) });
  assert.match(prod, /Te estás vinculando con: <b>Patagonia System<\/b>/);
  const staging = renderForm({ csrf: "t", target: describeCloud(STAGING_CLOUD_URL) });
  assert.match(staging, /class="error" data-nube="pruebas">Te estás vinculando con: <b>Patagonia System — sistema de PRUEBAS/);
  assert.match(renderPaired({ name: "Caja 1", target: describeCloud(STAGING_CLOUD_URL) }), /Vinculada con: <b>Patagonia System — sistema de PRUEBAS/);
});
