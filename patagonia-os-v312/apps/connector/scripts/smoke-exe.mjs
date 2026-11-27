// Prueba de humo del ejecutable armado (local y CI), SIN instalar el servicio:
//   1. `scale-connect.exe --version` devuelve la versión de package.json.
//   2. `scale-connect.exe` (modo consola) arranca con datos en una carpeta temporal y un
//      puerto libre, y GET /status responde con esa versión y el módulo serialport cargado.
// Uso: node scripts/smoke-exe.mjs [carpeta]   (por omisión dist/PatagoniaScaleConnect)

import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dir = path.resolve(process.argv[2] ?? path.join(root, "dist", "PatagoniaScaleConnect"));
const exe = path.join(dir, "scale-connect.exe");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

function fail(message) {
  console.error(`FALLÓ: ${message}`);
  process.exit(1);
}

// 1. --version
const version = execFileSync(exe, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
console.log(`> scale-connect.exe --version\n${version}`);
if (version !== pkg.version) fail(`--version dijo "${version}", se esperaba "${pkg.version}".`);

// 2. Modo consola con /status
const freePort = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const home = await mkdtemp(path.join(os.tmpdir(), "scale-connect-smoke-"));
await writeFile(path.join(home, "config.json"), JSON.stringify({ version: 1, http: { port: freePort }, devices: [] }));

const child = spawn(exe, [], { cwd: dir, env: { ...process.env, PATAGONIA_CONNECT_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));
let exited = null;
child.on("exit", (code) => (exited = code));

let status = null;
const deadline = Date.now() + 20_000;
while (Date.now() < deadline && exited === null) {
  try {
    const response = await fetch(`http://127.0.0.1:${freePort}/status`);
    if (response.ok) {
      status = await response.json();
      break;
    }
  } catch {
    // todavía no escucha
  }
  await new Promise((r) => setTimeout(r, 300));
}
child.kill();
await new Promise((r) => setTimeout(r, 500));
await rm(home, { recursive: true, force: true });

if (!status) fail(`/status no respondió (código de salida ${exited}).\n${output}`);
console.log(`> GET http://127.0.0.1:${freePort}/status`);
console.log(
  JSON.stringify(
    {
      service: status.service,
      version: status.version,
      computer: status.computer,
      ports: { ok: status.ports?.ok, count: status.ports?.ports?.length, error: status.ports?.error },
      jobs: status.jobs,
      problems: status.problems,
    },
    null,
    2,
  ),
);
if (status.version !== pkg.version) fail(`/status dijo versión ${status.version}.`);
if (status.ports?.ok !== true) fail(`No se pudieron listar los puertos (¿no cargó serialport?): ${status.ports?.error}`);
console.log("OK: el ejecutable arranca, responde /status y carga serialport.");
