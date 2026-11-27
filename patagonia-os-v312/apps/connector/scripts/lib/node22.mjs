// Elige el node.exe con el que se arma scale-connect.exe. Tiene que ser Node 22 LTS x64:
//   1. --node <ruta> o la variable SCALE_CONNECT_NODE, si se indica.
//   2. El Node que corre el script, si es 22.x x64 (el caso del CI).
//   3. Si no (esta PC tiene Node 24), baja Node 22 portable con su SHA-256 fijo a una
//      carpeta temporal FUERA del repo y usa ese.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadVerified } from "./download.mjs";
import { NODE22 } from "./pinned.mjs";

export function cacheDir() {
  return process.env.SCALE_CONNECT_CACHE?.trim() || path.join(os.tmpdir(), "patagonia-scale-connect-build");
}

function versionOf(nodeExe) {
  return execFileSync(nodeExe, ["-p", "process.version + ' ' + process.arch"], { encoding: "utf8" }).trim();
}

export async function resolveNode22(argv = process.argv) {
  const flag = argv.indexOf("--node");
  const explicit = flag >= 0 ? argv[flag + 1] : process.env.SCALE_CONNECT_NODE?.trim();
  if (explicit) {
    const found = versionOf(explicit);
    if (!found.startsWith("v22.") || !found.endsWith(" x64")) throw new Error(`${explicit} es ${found}; hace falta Node 22 x64.`);
    return { nodeExe: explicit, version: found.split(" ")[0], source: "indicado" };
  }
  if (process.version.startsWith("v22.") && process.arch === "x64") {
    return { nodeExe: process.execPath, version: process.version, source: "el que corre el script" };
  }

  const dir = path.join(cacheDir(), "node", NODE22.version);
  const zip = path.join(dir, `${NODE22.folder}.zip`);
  const nodeExe = path.join(dir, NODE22.folder, "node.exe");
  await downloadVerified({ url: NODE22.url, sha256: NODE22.sha256, dest: zip });
  if (!existsSync(nodeExe)) {
    // tar de Windows (bsdtar) abre .zip. Solo se extrae node.exe.
    const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    execFileSync(tar, ["-xf", zip, "-C", dir, `${NODE22.folder}/node.exe`], { stdio: "inherit" });
  }
  const found = versionOf(nodeExe);
  if (!found.startsWith(`${NODE22.version} `)) throw new Error(`El Node descargado dice ${found}, se esperaba ${NODE22.version}.`);
  return { nodeExe, version: NODE22.version, source: `descargado (SHA-256 verificado) en ${dir}` };
}
