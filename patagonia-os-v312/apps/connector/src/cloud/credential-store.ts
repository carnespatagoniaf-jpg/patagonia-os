// Credencial de la PC (id del conector + secreto), guardada fuera de config.json.
//
// Windows: el secreto se cifra con DPAPI de ALCANCE DE MÁQUINA (ProtectedData.Protect con LocalMachine y una
// entropía propia), vía PowerShell. Alcance de máquina y no de usuario porque el servicio corre con la cuenta
// virtual NT SERVICE\PatagoniaScaleConnect y una reinstalación puede cambiarla: lo que importa es que el archivo
// copiado a otra PC no sirva. (ConvertFrom-SecureString sin -Key usa DPAPI de USUARIO, por eso se usa
// ProtectedData directo.) El secreto viaja a PowerShell por la entrada estándar, nunca en la línea de comandos.
// La carpeta %ProgramData%\Patagonia\ScaleConnect la deja con permisos restringidos el instalador.
//
// Otros sistemas (solo desarrollo): archivo con permisos 0600 y el secreto sin cifrar.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile } from "../storage/atomic-file";

export interface StoredCredential {
  connectorId: string;
  secret: string;
  name: string;
  branchId: string | null;
  pairedAt: string;
}

export interface CredentialStore {
  readonly scheme: string;
  load(): Promise<StoredCredential | null>;
  save(credential: StoredCredential): Promise<void>;
  clear(): Promise<void>;
}

interface CredentialFile {
  version: 1;
  scheme: string;
  connectorId: string;
  name: string;
  branchId: string | null;
  pairedAt: string;
  /** El secreto protegido (DPAPI en base64) o, en desarrollo, tal cual. */
  protected: string;
}

/** Protege y desprotege el secreto. */
export interface SecretProtector {
  readonly scheme: string;
  protect(secret: string): Promise<string>;
  unprotect(data: string): Promise<string>;
}

let sequence = 0;

/** Escritura atómica con permisos 0600 desde el primer byte (no hay instante con el archivo legible por otros). */
async function writePrivateFile(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  sequence += 1;
  const tmp = `${file}.${process.pid}.${sequence}.tmp`;
  try {
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
    if (process.platform !== "win32") await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class FileCredentialStore implements CredentialStore {
  constructor(
    private readonly file: string,
    private readonly protector: SecretProtector,
  ) {}

  get scheme(): string {
    return this.protector.scheme;
  }

  async load(): Promise<StoredCredential | null> {
    const read = await readJsonFile<Partial<CredentialFile>>(this.file);
    if (read.status !== "ok") return null;
    const v = read.value;
    if (!v || v.version !== 1 || typeof v.connectorId !== "string" || typeof v.protected !== "string") return null;
    if (v.scheme !== this.protector.scheme) return null;
    const secret = await this.protector.unprotect(v.protected);
    return {
      connectorId: v.connectorId,
      secret,
      name: typeof v.name === "string" ? v.name : "",
      branchId: typeof v.branchId === "string" ? v.branchId : null,
      pairedAt: typeof v.pairedAt === "string" ? v.pairedAt : "",
    };
  }

  async save(credential: StoredCredential): Promise<void> {
    const content: CredentialFile = {
      version: 1,
      scheme: this.protector.scheme,
      connectorId: credential.connectorId,
      name: credential.name,
      branchId: credential.branchId,
      pairedAt: credential.pairedAt,
      protected: await this.protector.protect(credential.secret),
    };
    await writePrivateFile(this.file, `${JSON.stringify(content, null, 2)}\n`);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly scheme = "memoria";
  constructor(private value: StoredCredential | null = null) {}
  async load() {
    return this.value ? { ...this.value } : null;
  }
  async save(credential: StoredCredential) {
    this.value = { ...credential };
  }
  async clear() {
    this.value = null;
  }
}

/** Desarrollo: sin cifrar (el archivo igual queda 0600). */
export const plainProtector: SecretProtector = {
  scheme: "plain-dev",
  protect: async (s) => s,
  unprotect: async (s) => s,
};

export type PowerShellRunner = (script: string, input: string) => Promise<string>;

/** Corre un script de PowerShell 5.1 con -EncodedCommand y le pasa `input` por la entrada estándar. */
export const runWindowsPowerShell: PowerShellRunner = (script, input) =>
  new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`PowerShell falló: ${String(stderr || error.message).trim().slice(0, 300)}`));
        resolve(String(stdout).trim());
      },
    );
    child.stdin?.end(input, "utf8");
  });

const DPAPI_PRELUDE = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
$entropy = [Text.Encoding]::UTF8.GetBytes('PatagoniaScaleConnect|credencial|v1')
$scope = [Security.Cryptography.DataProtectionScope]::LocalMachine
`;
const DPAPI_PROTECT = `${DPAPI_PRELUDE}[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $entropy, $scope))`;
const DPAPI_UNPROTECT = `${DPAPI_PRELUDE}[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $entropy, $scope))`;

export function dpapiMachineProtector(run: PowerShellRunner = runWindowsPowerShell): SecretProtector {
  return {
    scheme: "dpapi-machine",
    async protect(secret) {
      const out = await run(DPAPI_PROTECT, secret);
      if (!/^[A-Za-z0-9+/=]{20,}$/.test(out)) throw new Error("DPAPI devolvió algo inesperado al cifrar.");
      return out;
    },
    async unprotect(data) {
      if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error("Credencial cifrada con formato inválido.");
      return run(DPAPI_UNPROTECT, data);
    },
  };
}

export function createCredentialStore(file: string, platform: NodeJS.Platform = process.platform): CredentialStore {
  return new FileCredentialStore(file, platform === "win32" ? dpapiMachineProtector() : plainProtector);
}
