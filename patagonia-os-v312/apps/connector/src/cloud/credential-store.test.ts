import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dpapiMachineProtector, FileCredentialStore, plainProtector, type PowerShellRunner } from "./credential-store";
import { fingerprintHash, parseRegMachineGuid } from "./fingerprint";

const CRED = { connectorId: "3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b", secret: "s".repeat(43), name: "Caja 1", branchId: null, pairedAt: "2026-11-27T00:00:00.000Z" };

test("archivo de desarrollo: ida y vuelta, permisos 0600, borrar", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scale-cred-"));
  const file = path.join(dir, "credential.json");
  const store = new FileCredentialStore(file, plainProtector);
  assert.equal(await store.load(), null);
  await store.save(CRED);
  assert.deepEqual(await store.load(), CRED);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  await store.clear();
  assert.equal(await store.load(), null);
});

test("un archivo de otro esquema o dañado no se usa", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scale-cred-"));
  const file = path.join(dir, "credential.json");
  await new FileCredentialStore(file, plainProtector).save(CRED);
  const fake: PowerShellRunner = async () => "";
  assert.equal(await new FileCredentialStore(file, dpapiMachineProtector(fake)).load(), null, "plano leído como DPAPI");
  await writeFile(file, "{roto");
  assert.equal(await new FileCredentialStore(file, plainProtector).load(), null);
});

test("DPAPI: el secreto va por la entrada estándar, nunca en el script, y en disco queda cifrado", async () => {
  const seen: Array<{ script: string; input: string }> = [];
  const fake: PowerShellRunner = async (script, input) => {
    seen.push({ script, input });
    return script.includes("::Protect(") ? Buffer.from(`cifrado:${input}`).toString("base64") : Buffer.from(input, "base64").toString().replace(/^cifrado:/, "");
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), "scale-cred-"));
  const file = path.join(dir, "credential.json");
  const store = new FileCredentialStore(file, dpapiMachineProtector(fake));
  await store.save(CRED);
  const onDisk = await readFile(file, "utf8");
  assert.equal(onDisk.includes(CRED.secret), false);
  assert.match(onDisk, /dpapi-machine/);
  assert.equal(seen[0].script.includes(CRED.secret), false);
  assert.match(seen[0].script, /LocalMachine/);
  assert.deepEqual(await store.load(), CRED);
});

test("DPAPI real de Windows (alcance de máquina)", { skip: process.platform !== "win32" ? "solo en Windows" : false }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scale-cred-"));
  const file = path.join(dir, "credential.json");
  const store = new FileCredentialStore(file, dpapiMachineProtector());
  await store.save(CRED);
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(onDisk.scheme, "dpapi-machine");
  assert.notEqual(onDisk.protected, CRED.secret);
  assert.equal(JSON.stringify(onDisk).includes(CRED.secret), false);
  assert.deepEqual(await store.load(), CRED);
});

test("huella: hash estable, sin el identificador crudo", () => {
  const a = fingerprintHash({ hostname: "CAJA-1", machineId: "ABC" });
  assert.equal(a, fingerprintHash({ hostname: "caja-1 ", machineId: "abc" }));
  assert.notEqual(a, fingerprintHash({ hostname: "caja-2", machineId: "abc" }));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(
    parseRegMachineGuid("\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0\r\n"),
    "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
  );
  assert.equal(parseRegMachineGuid("nada"), null);
});
