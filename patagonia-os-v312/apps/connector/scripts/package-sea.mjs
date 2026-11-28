// Empaquetado como ejecutable propio (Node SEA). SIN FIRMAR todavía.
// Uso: npm run package -w @patagonia/connector   [-- --node C:\ruta\node.exe]
//
// Deja en dist/PatagoniaScaleConnect/ (lo que copia el instalador):
//   scale-connect.exe            node.exe 22 (sin la firma de OpenJS) + el bundle inyectado
//   PatagoniaScaleConnect.exe    WinSW v3 x64, bajado con SHA-256 fijo (el envoltorio del servicio)
//   PatagoniaScaleConnect.xml    su configuración (packaging/)
//   node_modules/serialport/…    módulo nativo, solo el .node de win32-x64
//   build-info.json              versiones y SHA-256 de cada archivo
//
// Pasos:
//   1. dist/scale-connect.cjs lo arma scripts/build.mjs (el script "package" lo corre antes).
//   2. Elige Node 22 x64 (lib/node22.mjs: el que corre, --node, o lo baja verificado).
//   3. Genera el blob SEA con ESE node.exe (el formato del blob depende de la versión).
//   4. Copia node.exe, le saca la firma (lib/pe-unsign.mjs) e inyecta el blob (postject).
//   5. Copia serialport y sus dependencias, baja WinSW y copia el XML.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "postject";
import { downloadVerified, sha256File } from "./lib/download.mjs";
import { cacheDir, resolveNode22 } from "./lib/node22.mjs";
import { readSignatureInfo, removeSignature } from "./lib/pe-unsign.mjs";
import { SEA_FUSE, WINSW } from "./lib/pinned.mjs";
import { buildVersion } from "./lib/build-version.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(root, "dist");
const out = path.join(dist, "PatagoniaScaleConnect");
const exeName = "scale-connect.exe";
const bundle = path.join(dist, "scale-connect.cjs");

if (process.platform !== "win32") {
  console.error("El ejecutable del servicio se arma en Windows.");
  process.exit(1);
}
if (!existsSync(bundle)) {
  console.error("Falta dist/scale-connect.cjs: correr antes `node scripts/build.mjs` (o `npm run package`).");
  process.exit(1);
}

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const node = await resolveNode22();
console.log(`Node para el .exe: ${node.version} (${node.source})`);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// 3. Blob SEA, generado por el mismo Node que se va a inyectar.
const seaConfig = path.join(dist, "sea-config.json");
const blob = path.join(dist, "sea-prep.blob");
await writeFile(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2),
);
execFileSync(node.nodeExe, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 4. Ejecutable: node.exe sin firma + blob.
const exe = path.join(out, exeName);
const original = await readFile(node.nodeExe);
const signature = readSignatureInfo(original);
const { buffer: unsigned, removed } = removeSignature(original);
await writeFile(exe, unsigned);
console.log(removed ? `Firma de node.exe quitada (${signature.size} bytes).` : "node.exe no traía firma.");
await inject(exe, "NODE_SEA_BLOB", await readFile(blob), { sentinelFuse: SEA_FUSE });
console.log(`Bundle inyectado en ${exeName}.`);

// 5a. serialport y todo su árbol de dependencias de producción.
// (Se busca la carpeta subiendo por node_modules, como Node: varios paquetes tienen
// "exports" y no dejan resolver su package.json con require.resolve.)
function findPackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`No se encontró el paquete ${name} desde ${fromDir}`);
  }
}
const copied = new Set();
async function copyPackage(name, fromDir) {
  if (copied.has(name)) return;
  const pkgDir = findPackageDir(name, fromDir);
  copied.add(name);
  await cp(pkgDir, path.join(out, "node_modules", name), {
    recursive: true,
    // Solo los .node de Windows x64; el resto de plataformas, pruebas y documentación sobra.
    filter: (src) => !/[\\/]prebuilds[\\/](?!win32-x64)[^\\/]+/.test(src) && !/[\\/](test|docs?|\.github)[\\/]/i.test(src),
  });
  const deps = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8")).dependencies ?? {};
  for (const dep of Object.keys(deps)) await copyPackage(dep, pkgDir);
}
await copyPackage("serialport", root);
console.log(`Dependencias nativas copiadas: ${[...copied].join(", ")}`);

// 5b. WinSW (SHA-256 fijo) + su XML.
const winsw = await downloadVerified({
  url: WINSW.url,
  sha256: WINSW.sha256,
  dest: path.join(cacheDir(), "winsw", WINSW.version, "WinSW-x64.exe"),
});
await copyFile(winsw, path.join(out, "PatagoniaScaleConnect.exe"));
await copyFile(path.join(root, "packaging", "PatagoniaScaleConnect.xml"), path.join(out, "PatagoniaScaleConnect.xml"));
// La tarea programada del actualizador (la registra el instalador como administrador).
await copyFile(path.join(root, "packaging", "updater-task.ps1"), path.join(out, "updater-task.ps1"));
console.log(`WinSW ${WINSW.version} verificado.`);

// build-info.json: qué se armó y con qué (lo lee soporte y el CI).
async function listFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(full)));
    else result.push(full);
  }
  return result;
}
const files = {};
for (const file of (await listFiles(out)).sort()) {
  files[path.relative(out, file).replaceAll("\\", "/")] = { bytes: (await stat(file)).size, sha256: await sha256File(file) };
}
await writeFile(
  path.join(out, "build-info.json"),
  JSON.stringify({ product: "patagonia-scale-connect", version: buildVersion(pkg.version), node: node.version, winsw: WINSW.version, signed: false, builtAt: new Date().toISOString(), files }, null, 2),
);

const mb = (files[exeName].bytes / 1024 / 1024).toFixed(1);
console.log(`Listo: ${out}\n  ${exeName} ${mb} MB, versión ${buildVersion(pkg.version)}, SIN FIRMAR.`);
