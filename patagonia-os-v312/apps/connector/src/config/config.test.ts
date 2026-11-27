import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, isLocalNetworkIPv4, loadConfig, parseConfig } from "./config";
import { resolvePaths } from "./paths";

test("rutas: ProgramData en producción, .data en desarrollo, y se puede forzar", () => {
  const prod = resolvePaths({ dev: false, env: { ProgramData: "C:\\ProgramData" }, cwd: "C:\\x" });
  assert.equal(prod.root, "C:\\ProgramData\\Patagonia\\ScaleConnect");
  assert.equal(prod.configFile, "C:\\ProgramData\\Patagonia\\ScaleConnect\\config.json");
  assert.equal(prod.logsDir, "C:\\ProgramData\\Patagonia\\ScaleConnect\\logs");
  assert.equal(prod.journalFile, "C:\\ProgramData\\Patagonia\\ScaleConnect\\journal\\jobs.json");
  const dev = resolvePaths({ dev: true, env: {}, cwd: path.resolve("repo") });
  assert.equal(dev.root, path.join(path.resolve("repo"), ".data"));
  const forced = resolvePaths({ dev: false, env: { PATAGONIA_CONNECT_HOME: path.resolve("otra") }, cwd: "." });
  assert.equal(forced.root, path.resolve("otra"));
});

test("solo IPs de red local para balanzas de red", () => {
  for (const ok of ["192.168.0.50", "10.1.2.3", "172.16.0.1", "172.31.255.255", "169.254.137.200"]) assert.equal(isLocalNetworkIPv4(ok), true, ok);
  for (const bad of ["8.8.8.8", "172.32.0.1", "127.0.0.1", "192.168.0.256", "balanza.local", "", "::1"]) assert.equal(isLocalNetworkIPv4(bad), false, bad);
});

test("configuración vacía = de fábrica", () => {
  const { config, errors } = parseConfig({});
  assert.deepEqual(errors, []);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(config.http.port, 9120);
});

test("balanzas válidas, por COM y por red", () => {
  const { config, errors } = parseConfig({
    devices: [
      { id: "mostrador", name: "Aura mostrador", transport: { type: "serial", path: "com3", baudRate: 9600, stopBits: 2 } },
      { id: "report", transport: { type: "tcp", host: "169.254.137.200", port: 1001 } },
    ],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.devices[0].transport, { type: "serial", path: "COM3", baudRate: 9600, stopBits: 2 });
  assert.equal(config.devices[1].name, "report");
});

test("lo inválido se informa y se saltea, sin impedir el arranque", () => {
  const { config, errors } = parseConfig({
    http: { port: 80 },
    watchdogMs: 5,
    backoffMs: [1000, "x"],
    log: { level: "todo" },
    devices: [
      { id: "a", transport: { type: "tcp", host: "8.8.8.8", port: 1001 } },
      { id: "b", transport: { type: "serial", path: "/dev/ttyUSB0", baudRate: 9600 } },
      { id: "c", transport: { type: "serial", path: "COM1", baudRate: 12345 } },
      { id: "ok", transport: { type: "serial", path: "COM1", baudRate: 115200 } },
      { id: "ok", transport: { type: "serial", path: "COM2", baudRate: 115200 } },
      { id: "con espacio", transport: { type: "tcp", host: "10.0.0.1", port: 1 } },
      { id: "d", transport: { type: "usb" } },
    ],
  });
  assert.equal(config.http.port, 9120);
  assert.equal(config.watchdogMs, DEFAULT_CONFIG.watchdogMs);
  assert.deepEqual(config.backoffMs, DEFAULT_CONFIG.backoffMs);
  assert.deepEqual(config.devices.map((d) => d.id), ["ok"]);
  assert.equal(errors.length, 10);
});

test("loadConfig crea la de fábrica si no existe, y aparta una dañada", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scale-connect-config-"));
  const file = path.join(dir, "config.json");
  const first = await loadConfig(file);
  assert.equal(first.createdDefault, true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), DEFAULT_CONFIG);
  await writeFile(file, "{ roto", "utf8");
  const broken = await loadConfig(file);
  assert.equal(broken.config.http.port, 9120);
  assert.match(broken.errors[0], /dañado/);
});
