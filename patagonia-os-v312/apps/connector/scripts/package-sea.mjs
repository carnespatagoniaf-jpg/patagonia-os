// Empaquetado como ejecutable propio (Node SEA). SIN FIRMAR todavía.
//
// Deja en dist/package/:
//   scale-connect.exe                node.exe + el bundle inyectado
//   PatagoniaScaleConnect.xml        configuración de WinSW (el servicio)
//   (PatagoniaScaleConnect.exe = WinSW-x64.exe renombrado; lo agrega el instalador)
//   node_modules/serialport/…        módulo nativo con su .node precompilado
//
// Pasos (los 1-3 los hace este script; el 4 hace falta postject):
//   1. dist/scale-connect.cjs (scripts/build.mjs).
//   2. Blob SEA: node --experimental-sea-config sea-config.json
//   3. Copia node.exe -> PatagoniaScaleConnect.exe y las dependencias nativas.
//   4. Inyecta el blob: npx postject … (Node 22/24). Si postject no está
//      instalado, el script lo avisa y deja todo lo demás listo.
//
// IMPORTANTE: el .exe se arma con el node.exe que corre este script. Para
// producción usar Node 22 LTS x64 (`node -v`). node.exe viene firmado por la
// OpenJS Foundation; al inyectar se rompe esa firma: hay que quitarla antes
// (`signtool remove /s`) y firmar con el certificado propio después.

import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(root, "dist");
const out = path.join(dist, "package");
const exeName = "scale-connect.exe";

if (process.platform !== "win32") {
  console.error("El ejecutable del servicio se arma en Windows.");
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// 2. Blob SEA
const seaConfig = path.join(dist, "sea-config.json");
const blob = path.join(dist, "sea-prep.blob");
await writeFile(
  seaConfig,
  JSON.stringify(
    {
      main: path.join(dist, "scale-connect.cjs"),
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 3. Ejecutable base + WinSW + dependencias nativas
await copyFile(process.execPath, path.join(out, exeName));
await copyFile(path.join(root, "packaging", "PatagoniaScaleConnect.xml"), path.join(out, "PatagoniaScaleConnect.xml"));

// Copia serialport y todo su árbol de dependencias de producción.
// (Se busca la carpeta subiendo por node_modules, como Node: varios paquetes
// tienen "exports" y no dejan resolver su package.json con require.resolve.)
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
  const pkgJsonPath = path.join(pkgDir, "package.json");
  copied.add(name);
  await cp(pkgDir, path.join(out, "node_modules", name), {
    recursive: true,
    // Solo los .node de Windows x64; el resto de plataformas sobra.
    filter: (src) => !/[\\/]prebuilds[\\/](?!win32-x64)[^\\/]+/.test(src) && !/[\\/](test|docs?|\.github)[\\/]/i.test(src),
  });
  const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) await copyPackage(dep, pkgDir);
}
await copyPackage("serialport", root);
console.log(`Dependencias nativas copiadas: ${[...copied].join(", ")}`);

// 4. Inyección del blob
const exe = path.join(out, exeName);
const postjectArgs = [
  exe,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
const localPostject = path.join(root, "..", "..", "node_modules", ".bin", "postject.cmd");
if (existsSync(localPostject)) {
  execFileSync(localPostject, postjectArgs, { stdio: "inherit", shell: true });
  console.log(`Listo: ${exe} (SIN FIRMAR)`);
} else {
  console.log(
    [
      "",
      "Falta postject para inyectar el bundle en el .exe. Opciones:",
      "  npm i -D postject -w @patagonia/connector   (y volver a correr este script)",
      `  o a mano: npx postject "${exe}" NODE_SEA_BLOB "${blob}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
      "Todo lo demás quedó en dist/package/.",
    ].join("\n"),
  );
}
