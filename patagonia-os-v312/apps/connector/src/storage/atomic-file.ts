// Escritura atómica: se escribe un archivo temporal, se fuerza a disco y se
// renombra encima del definitivo. Si se corta la luz a mitad, queda el archivo
// viejo entero o el nuevo entero, nunca uno a medias.

import { promises as fs } from "node:fs";
import path from "node:path";

let sequence = 0;

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  // En Windows un antivirus o el indexador pueden tener el destino abierto un
  // instante: se reintenta con espera corta.
  for (let i = 0; ; i += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || i >= attempts - 1) throw error;
      await new Promise((r) => setTimeout(r, 15 * 2 ** i));
    }
  }
}

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  sequence += 1;
  const tmp = `${file}.${process.pid}.${sequence}.tmp`;
  try {
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export type JsonReadResult<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "corrupt"; movedTo: string; error: string };

/**
 * Lee un JSON. Si está dañado, lo aparta como "<archivo>.corrupt-<fecha>"
 * (para soporte) en vez de pisarlo, y avisa.
 */
export async function readJsonFile<T>(file: string, now: () => Date = () => new Date()): Promise<JsonReadResult<T>> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw error;
  }
  try {
    return { status: "ok", value: JSON.parse(text) as T };
  } catch (error) {
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const movedTo = `${file}.corrupt-${stamp}`;
    await renameWithRetry(file, movedTo);
    return { status: "corrupt", movedTo, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Borra temporales que quedaron de una escritura interrumpida. */
export async function cleanupTempFiles(file: string): Promise<number> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let removed = 0;
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (name.startsWith(`${base}.`) && name.endsWith(".tmp")) {
      await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}
