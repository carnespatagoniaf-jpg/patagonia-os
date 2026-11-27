// Descarga con verificación de SHA-256. Si el archivo ya está en la caché y su hash
// coincide, no se vuelve a bajar. Si no coincide, no se guarda y el build se frena.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function sha256File(file) {
  return sha256Hex(await readFile(file));
}

export async function downloadVerified({ url, sha256, dest }) {
  const expected = sha256.toLowerCase();
  if (existsSync(dest) && (await sha256File(dest)) === expected) return dest;
  await mkdir(path.dirname(dest), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`No se pudo bajar ${url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = sha256Hex(data);
  if (actual !== expected) {
    throw new Error(`SHA-256 distinto para ${url}\n  esperado ${expected}\n  recibido ${actual}\nNo se usa el archivo.`);
  }
  const tmp = `${dest}.part`;
  await writeFile(tmp, data);
  await rm(dest, { force: true });
  await rename(tmp, dest);
  return dest;
}
