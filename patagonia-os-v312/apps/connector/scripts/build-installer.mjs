// Compila el instalador (packaging/installer.iss) con Inno Setup y escribe su SHA-256.
// Uso: npm run installer -w @patagonia/connector
// Antes: npm run package -w @patagonia/connector (deja dist/PatagoniaScaleConnect/).
//
// Busca ISCC.exe en la variable ISCC o en las carpetas de instalación de Inno Setup 6.
// Deja en dist/installer/:
//   PatagoniaScaleConnect-Setup-<versión>.exe          SIN FIRMAR
//   PatagoniaScaleConnect-Setup-<versión>.exe.sha256   "<hash> *<nombre>" (formato sha256sum)

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/download.mjs";
import { buildVersion } from "./lib/build-version.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = path.join(root, "dist", "PatagoniaScaleConnect");
const outputDir = path.join(root, "dist", "installer");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = buildVersion(pkg.version);

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  // Inno Setup (VersionInfoVersion) solo acepta números.
  console.error(`La versión ${version} no es X.Y.Z: el instalador necesita una versión numérica.`);
  process.exit(1);
}
if (!existsSync(path.join(source, "scale-connect.exe"))) {
  console.error("Falta dist/PatagoniaScaleConnect: correr antes `npm run package -w @patagonia/connector`.");
  process.exit(1);
}

const candidates = [
  process.env.ISCC,
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Inno Setup 6", "ISCC.exe"),
].filter(Boolean);
const iscc = candidates.find((file) => existsSync(file));
if (!iscc) {
  console.error(`No se encontró ISCC.exe (Inno Setup 6.3+). Buscado en:\n  ${candidates.join("\n  ")}\nInstalarlo o indicar la ruta en la variable ISCC.`);
  process.exit(1);
}

execFileSync(
  iscc,
  [
    "/Qp",
    `/DAppVersion=${version}`,
    `/DSourceDir=${source}`,
    `/DOutputDir=${outputDir}`,
    path.join(root, "packaging", "installer.iss"),
  ],
  { stdio: "inherit" },
);

const name = `PatagoniaScaleConnect-Setup-${version}.exe`;
const installer = path.join(outputDir, name);
const hash = await sha256File(installer);
await writeFile(`${installer}.sha256`, `${hash} *${name}\n`);
console.log(`Listo: ${installer} (SIN FIRMAR)\nSHA-256: ${hash}`);
