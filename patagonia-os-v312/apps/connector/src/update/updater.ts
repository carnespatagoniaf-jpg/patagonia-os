// Actualizador de Patagonia Scale Connect (corre como SYSTEM desde una tarea programada; ver updater-run.ts).
//
// El servicio corre con NT SERVICE\PatagoniaScaleConnect, que no es administrador y no puede instalar en Program
// Files. Por eso la actualización la hace este proceso aparte. Una corrida (runOnce):
//   1. Pide la oferta a Patagonia (scale-connect-api/update) con la credencial de la PC.
//   2. Verifica: firma Ed25519 con la clave EMBEBIDA, canal, versión mínima y que sea más nueva que la instalada
//      (checkUpdateOffer); baja el instalador y compara tamaño y SHA-256 con el manifiesto firmado (verifyInstaller).
//   3. Le pide al servicio que no tome trabajos nuevos (pausa.json) y espera, hasta 30 minutos, a que /status diga
//      que no hay trabajos en curso. Si no se vacía, lo deja para la próxima.
//   4. Guarda el instalador de la versión instalada como "anterior" e instala el nuevo en silencio
//      (/VERYSILENT /SUPPRESSMSGBOXES /NORESTART, sin /NUBE=: conserva datos y nube).
//   5. Comprueba la salud: en 2 minutos /status tiene que responder con la versión nueva y (si antes estaba en línea)
//      con un latido posterior a la instalación.
//   6. Si algo falla, reinstala la anterior (verificada con el SHA-256 que quedó anotado), bloquea esa versión y avisa.
// Nunca baja de versión por una oferta: la única "bajada" es volver a la que ya estaba instalada en esta PC.

import { createHash, type KeyObject } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkUpdateOffer, compareVersions, verifyInstaller, type UpdateManifest } from "../../scripts/lib/update-manifest.mjs";
import { silentLogger, type Logger } from "../log/logger";
import { readJsonFile, writeFileAtomic } from "../storage/atomic-file";
import type { UpdaterPaths } from "./update-paths";

/** Lo que devuelve la nube (migración 229). Del servidor solo se usa el manifiesto firmado y el canal. */
export interface UpdateOfferResponse {
  channel: "pilot" | "stable";
  offer: { version: string; manifest: unknown } | null;
}

/** Lo que importa de GET 127.0.0.1:9120/status. */
export interface LocalStatus {
  version: string;
  runningJobs: number;
  cloudState: string | null;
  lastHeartbeatAt: string | null;
}

export type UpdateResultKind =
  | "apagada" // sin clave pública embebida
  | "sin_nube" // la PC no está vinculada o no tiene nube
  | "sin_oferta"
  | "rechazada" // la firma, el canal, la versión o el hash no cierran
  | "bloqueada" // esa versión ya falló en esta PC
  | "sin_respaldo" // no hay instalador de la versión actual para volver atrás
  | "ocupado" // el servicio siguió con trabajos 30 minutos
  | "instalada"
  | "revertida" // la nueva no levantó y se volvió a la anterior
  | "fallo_reversion" // la nueva no levantó y la anterior tampoco: hay que ir a la PC
  | "error";

export interface UpdateResult {
  result: UpdateResultKind;
  from: string;
  to: string | null;
  message: string;
  at: string;
}

export interface UpdaterState {
  version: 1;
  installed: { version: string } | null;
  previous: { version: string; sha256: string } | null;
  /** Versión → motivo: no se reintenta (una versión más nueva sí). */
  blocked: Record<string, string>;
  lastCheckAt: string | null;
  lastResult: UpdateResult | null;
}

export const EMPTY_STATE: UpdaterState = { version: 1, installed: null, previous: null, blocked: {}, lastCheckAt: null, lastResult: null };

export const SILENT_ARGS = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"] as const;

export interface UpdaterDeps {
  /** La clave embebida (update-key.ts). null = actualización apagada. */
  publicKey: KeyObject | null;
  installedVersion: string;
  paths: UpdaterPaths;
  /** null = sin nube o sin vincular. */
  getOffer(currentVersion: string): Promise<UpdateOfferResponse | null>;
  download(url: string, maxBytes: number): Promise<Uint8Array>;
  /** null = el servicio no contesta. */
  getStatus(): Promise<LocalStatus | null>;
  /** Corre el instalador y devuelve su código de salida. */
  runInstaller(file: string, args: string[]): Promise<number>;
  /** Avisos al servicio (pausa.json). */
  setPause(until: Date | null, version: string | null): Promise<void>;
  report(result: UpdateResult): Promise<void>;
  logger?: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  idleWaitMs?: number;
  idlePollMs?: number;
  healthWaitMs?: number;
  healthPollMs?: number;
}

const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;
const CHANNEL_FOR_MANIFEST: Record<string, string> = { pilot: "piloto", stable: "general" };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileSha256(file: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(file));
  } catch {
    return null;
  }
}

export async function loadState(file: string): Promise<UpdaterState> {
  try {
    const r = await readJsonFile<UpdaterState>(file);
    if (r.status !== "ok" || typeof r.value !== "object" || r.value === null) return { ...EMPTY_STATE, blocked: {} };
    return { ...EMPTY_STATE, ...r.value, blocked: { ...(r.value.blocked ?? {}) } };
  } catch {
    return { ...EMPTY_STATE, blocked: {} };
  }
}

export async function saveState(file: string, state: UpdaterState): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** ¿Hay que revisar ahora? Cada 6 h, al arrancar Windows o cuando el servicio dejó un pedido. */
export function shouldCheck(input: { requested: boolean; lastCheckAt: string | null; now: Date; uptimeSec: number }): { run: boolean; reason: string } {
  if (input.requested) return { run: true, reason: "pedido del servicio" };
  const last = input.lastCheckAt ? Date.parse(input.lastCheckAt) : NaN;
  if (Number.isNaN(last)) return { run: true, reason: "primera revisión" };
  const bootAt = input.now.getTime() - input.uptimeSec * 1000;
  if (last < bootAt) return { run: true, reason: "arranque de Windows" };
  if (input.now.getTime() - last >= 6 * 3600 * 1000) return { run: true, reason: "pasaron 6 horas" };
  return { run: false, reason: "revisado hace menos de 6 horas" };
}

export class Updater {
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: UpdaterDeps) {
    this.log = (deps.logger ?? silentLogger).child({ module: "actualizador" });
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private result(kind: UpdateResultKind, to: string | null, message: string): UpdateResult {
    return { result: kind, from: this.deps.installedVersion, to, message: message.slice(0, 300), at: this.now().toISOString() };
  }

  /** Una corrida completa. Nunca tira: todo termina en un UpdateResult (anotado en estado.json y avisado). */
  async runOnce(): Promise<UpdateResult> {
    const state = await loadState(this.deps.paths.stateFile);
    let outcome: UpdateResult;
    try {
      outcome = await this.check(state);
    } catch (error) {
      this.log.error("La actualización falló", { error });
      outcome = this.result("error", null, error instanceof Error ? error.message : String(error));
      await this.deps.setPause(null, null).catch(() => undefined);
    }
    state.lastCheckAt = this.now().toISOString();
    state.lastResult = outcome;
    await saveState(this.deps.paths.stateFile, state);
    // Lo que no es noticia (no hay nada, ya está) no se informa a la nube en cada corrida.
    if (!["sin_oferta", "sin_nube", "apagada"].includes(outcome.result)) {
      await this.deps.report(outcome).catch((error) => this.log.warn("No se pudo informar el resultado a Patagonia", { error }));
    }
    this.log.info("Actualización: resultado", { ...outcome });
    return outcome;
  }

  private async check(state: UpdaterState): Promise<UpdateResult> {
    const { publicKey, installedVersion, paths } = this.deps;
    if (!publicKey) return this.result("apagada", null, "Actualización automática apagada: este programa no trae la clave pública.");

    const response = await this.deps.getOffer(installedVersion);
    if (!response) return this.result("sin_nube", null, "La PC no está vinculada con Patagonia.");
    if (!response.offer) return this.result("sin_oferta", null, "No hay versión nueva para esta PC.");

    const manifest = response.offer.manifest as UpdateManifest;
    const channel = CHANNEL_FOR_MANIFEST[response.channel] ?? "general";
    const offered = typeof manifest?.version === "string" ? manifest.version : null;
    const verdict = checkUpdateOffer(manifest, publicKey, { currentVersion: installedVersion, channel, now: this.now() });
    if (!verdict.ok) return this.result("rechazada", offered, verdict.reason);
    const target = manifest.version;
    if (state.blocked[target]) return this.result("bloqueada", target, `La ${target} ya falló en esta PC: ${state.blocked[target]}`);
    if (manifest.size > MAX_INSTALLER_BYTES) return this.result("rechazada", target, "El instalador es demasiado grande.");

    // Para poder volver atrás hace falta el instalador de lo que está instalado (lo deja el propio instalador).
    const currentSha = await fileSha256(paths.currentInstaller);
    if (!currentSha) return this.result("sin_respaldo", target, "No está guardado el instalador de la versión actual: no se actualiza sin poder volver atrás.");

    const bytes = await this.deps.download(manifest.url, manifest.size);
    const integrity = verifyInstaller(bytes, manifest);
    if (!integrity.ok) return this.result("rechazada", target, integrity.reason);
    await fs.mkdir(paths.downloadsDir, { recursive: true });
    const installer = path.join(paths.downloadsDir, `PatagoniaScaleConnect-Setup-${target}.exe`);
    await writeFileAtomic(installer, bytes);
    // Lo que se ejecuta es lo que está en el disco: se vuelve a comprobar ahí.
    if ((await fileSha256(installer)) !== manifest.sha256) return this.result("rechazada", target, "El instalador cambió en el disco.");

    // Esperar a que el servicio quede sin trabajos (y que no tome nuevos).
    await this.deps.setPause(new Date(this.now().getTime() + (this.deps.idleWaitMs ?? 30 * 60_000) + 15 * 60_000), target);
    const before = await this.waitIdle();
    if (before === "busy") {
      await this.deps.setPause(null, null);
      await fs.rm(installer, { force: true });
      return this.result("ocupado", target, "El servicio siguió con trabajos durante 30 minutos: se reintenta más tarde.");
    }
    const wasOnline = before !== null && before.cloudState === "en_linea";

    // Respaldo de la versión actual para volver atrás.
    await fs.copyFile(paths.currentInstaller, paths.previousInstaller);
    state.previous = { version: installedVersion, sha256: currentSha };
    await saveState(paths.stateFile, state);

    const installAt = this.now();
    this.log.info("Instalando versión nueva", { from: installedVersion, to: target });
    let code: number;
    try {
      code = await this.deps.runInstaller(installer, [...SILENT_ARGS, `/LOG=${path.join(paths.logsDir, `instalacion-${target}.log`)}`]);
    } catch (error) {
      code = -1;
      this.log.error("No se pudo correr el instalador", { error });
    }
    const healthy = code === 0 ? await this.waitHealthy(target, wasOnline, installAt) : null;
    if (code === 0 && healthy === null) {
      state.installed = { version: target };
      await fs.copyFile(installer, paths.currentInstaller).catch(() => undefined);
      await fs.rm(installer, { force: true });
      await this.deps.setPause(null, null);
      return this.result("instalada", target, `Actualizada de ${installedVersion} a ${target}.`);
    }

    const why = code !== 0 ? `el instalador terminó con código ${code}` : healthy ?? "no levantó";
    this.log.error("La versión nueva no anduvo: se vuelve a la anterior", { to: target, why });
    state.blocked[target] = why.slice(0, 200);
    await saveState(paths.stateFile, state);
    const back = await this.rollback(state, wasOnline);
    await fs.rm(installer, { force: true });
    await this.deps.setPause(null, null);
    if (back === null) return this.result("revertida", target, `La ${target} no anduvo (${why}); volvió a la ${installedVersion}.`);
    return this.result("fallo_reversion", target, `La ${target} no anduvo (${why}) y volver a la ${installedVersion} también falló (${back}).`);
  }

  /** null = el servicio no contesta (no puede tener trabajos); "busy" = siguió ocupado todo el plazo. */
  private async waitIdle(): Promise<LocalStatus | null | "busy"> {
    const deadline = this.now().getTime() + (this.deps.idleWaitMs ?? 30 * 60_000);
    for (;;) {
      const status = await this.deps.getStatus();
      if (!status || status.runningJobs === 0) return status;
      if (this.now().getTime() >= deadline) return "busy";
      this.log.info("Esperando a que terminen los trabajos en curso", { running: status.runningJobs });
      await this.sleep(this.deps.idlePollMs ?? 15_000);
    }
  }

  /** null = sano; si no, el motivo. */
  private async waitHealthy(version: string, needHeartbeat: boolean, since: Date): Promise<string | null> {
    const deadline = this.now().getTime() + (this.deps.healthWaitMs ?? 2 * 60_000);
    let last = "el servicio no contesta";
    for (;;) {
      const s = await this.deps.getStatus();
      if (s) {
        if (s.version !== version) last = `responde la versión ${s.version}`;
        else if (needHeartbeat && !(s.cloudState === "en_linea" && s.lastHeartbeatAt && Date.parse(s.lastHeartbeatAt) >= since.getTime() - 1000)) {
          last = "no llegó a latir con Patagonia";
        } else return null;
      }
      if (this.now().getTime() >= deadline) return `${last} a los 2 minutos`;
      await this.sleep(this.deps.healthPollMs ?? 5_000);
    }
  }

  private async rollback(state: UpdaterState, wasOnline: boolean): Promise<string | null> {
    const { paths } = this.deps;
    const prev = state.previous;
    if (!prev) return "no hay versión anterior anotada";
    // La carpeta es solo de SYSTEM y Administradores; igual se compara con el hash anotado antes de instalar.
    if ((await fileSha256(paths.previousInstaller)) !== prev.sha256) return "el instalador guardado de la anterior no coincide";
    const at = this.now();
    let code: number;
    try {
      code = await this.deps.runInstaller(paths.previousInstaller, [...SILENT_ARGS, `/LOG=${path.join(paths.logsDir, `reversion-${prev.version}.log`)}`]);
    } catch (error) {
      return `no se pudo correr: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (code !== 0) return `el instalador terminó con código ${code}`;
    const health = await this.waitHealthy(prev.version, wasOnline, at);
    if (health) return health;
    state.installed = { version: prev.version };
    await fs.copyFile(paths.previousInstaller, paths.currentInstaller).catch(() => undefined);
    return null;
  }
}

/** Para el servicio: ¿la versión ofrecida es más nueva que la instalada? */
export function isNewer(offered: string | null | undefined, current: string): boolean {
  if (typeof offered !== "string") return false;
  try {
    return compareVersions(offered, current) > 0;
  } catch {
    return false;
  }
}
