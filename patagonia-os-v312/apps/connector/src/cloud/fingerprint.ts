// Huella de la PC para reconocerla al reinstalar ("¿Es Caja 1?", plan §5.7): nombre del equipo + identificador
// de Windows (MachineGuid). Sale de la PC solo como SHA-256: Patagonia nunca ve el identificador crudo.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";

export function fingerprintHash(input: { hostname: string; machineId: string | null }): string {
  const material = `patagonia-scale-connect|${input.hostname.trim().toLowerCase()}|${(input.machineId ?? "").trim().toLowerCase()}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** MachineGuid de HKLM\SOFTWARE\Microsoft\Cryptography (se lee sin permisos de administrador). */
export function parseRegMachineGuid(output: string): string | null {
  const m = /MachineGuid\s+REG_SZ\s+([0-9a-f-]{36})/i.exec(output);
  return m ? m[1].toLowerCase() : null;
}

async function windowsMachineGuid(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : parseRegMachineGuid(String(stdout)));
    });
  });
}

async function unixMachineId(): Promise<string | null> {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = (await readFile(file, "utf8")).trim();
      if (id) return id;
    } catch {
      // sigue con el próximo
    }
  }
  return null;
}

export async function computeFingerprint(platform: NodeJS.Platform = process.platform): Promise<string> {
  const machineId = platform === "win32" ? await windowsMachineGuid() : await unixMachineId();
  return fingerprintHash({ hostname: os.hostname(), machineId });
}
