import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger, createMemoryLogger, redact, redactText } from "./logger";

test("redact borra campos con nombre de secreto, en cualquier profundidad", () => {
  const out = redact({
    deviceId: "b1",
    token: "abc",
    credential: { secret: "x" },
    nested: { Authorization: "Bearer zzz", apiKey: "k", pin: "1234", pinned: true, list: [{ password: "p" }] },
  }) as Record<string, any>;
  assert.equal(out.deviceId, "b1");
  assert.equal(out.token, "[oculto]");
  assert.equal(out.credential, "[oculto]");
  assert.equal(out.nested.Authorization, "[oculto]");
  assert.equal(out.nested.apiKey, "[oculto]");
  assert.equal(out.nested.pin, "[oculto]");
  assert.equal(out.nested.pinned, true);
  assert.equal(out.nested.list[0].password, "[oculto]");
});

test("redactText borra secretos dentro de textos libres", () => {
  assert.equal(redactText("Authorization: Bearer eyJhbGciOi.abc.def"), "Authorization: Bearer [oculto]");
  assert.equal(redactText("url?token=abc123&x=1"), "url?token=[oculto]&x=1");
  assert.equal(redactText('password: "hola mundo"'), "password: [oculto]");
  assert.equal(redactText("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----"), "[oculto]");
  assert.equal(redactText("COM3 no respondió"), "COM3 no respondió");
});

test("los errores se guardan con nombre, mensaje y código, sin secretos", () => {
  const error = Object.assign(new Error("fallo con token=xyz"), { code: "EACCES" });
  const out = redact(error) as Record<string, unknown>;
  assert.deepEqual(out, { name: "Error", message: "fallo con token=[oculto]", code: "EACCES" });
});

test("los bytes se resumen en hexadecimal", () => {
  assert.deepEqual(redact(new Uint8Array([7, 0x30, 4])), { bytes: 3, hex: "073004" });
});

test("la bitácora escribe JSON por línea y respeta el nivel", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scale-connect-log-"));
  const log = createLogger({ dir, level: "info" });
  log.debug("no va");
  log.info("Balanza conectada", { device: "b1", token: "secreto" });
  log.child({ device: "b2" }).warn("Desconectada");
  const lines = (await readFile(path.join(dir, "connector.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].msg, "Balanza conectada");
  assert.equal(lines[0].token, "[oculto]");
  assert.equal(lines[1].device, "b2");
  assert.equal(lines[1].level, "warn");
});

test("la bitácora rota por tamaño y conserva N archivos", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scale-connect-log-"));
  const log = createLogger({ dir, maxBytes: 1000, maxFiles: 2 });
  for (let i = 0; i < 60; i += 1) log.info(`línea ${i}`, { relleno: "x".repeat(40) });
  const names = (await readdir(dir)).sort();
  assert.deepEqual(names, ["connector.1.log", "connector.2.log", "connector.log"]);
  for (const name of names) {
    const size = (await readFile(path.join(dir, name))).length;
    assert.ok(size <= 1000, `${name} pesa ${size}`);
  }
  const last = (await readFile(path.join(dir, "connector.log"), "utf8")).trim().split("\n").pop()!;
  assert.match(JSON.parse(last).msg, /línea 59/);
});

test("si no se puede escribir la bitácora, no tira excepción", () => {
  const log = createLogger({ dir: path.join(os.tmpdir(), "\u0000inválido") });
  assert.doesNotThrow(() => log.error("igual sigue"));
});

test("bitácora en memoria para pruebas", () => {
  const log = createMemoryLogger();
  log.child({ device: "b1" }).info("hola", { secret: "s" });
  assert.equal(log.entries[0].fields.device, "b1");
  assert.equal(log.entries[0].fields.secret, "[oculto]");
});
