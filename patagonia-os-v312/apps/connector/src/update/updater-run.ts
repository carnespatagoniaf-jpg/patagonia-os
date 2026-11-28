// `scale-connect.exe --update`: lo corre la tarea programada "Patagonia\Actualizador de Patagonia Scale Connect"
// (como SYSTEM, al arrancar Windows y cada 15 minutos; la registra packaging/updater-task.ps1 desde el instalador).
//
// 1. Lanzador (`--update`, desde Program Files): se copia a ScaleConnect-Updater\bin\scale-connect-updater-<versión>.exe
//    y arranca esa copia con `--update-run`, y sale enseguida. Así el instalador puede reemplazar scale-connect.exe
//    (no está en uso) y su "taskkill /IM scale-connect.exe" no mata al actualizador a mitad de camino.
// 2. Corrida (`--update-run`): si toca (pedido del servicio, arranque de Windows o 6 h desde la última revisión) y no
//    hay otra en curso, hace Updater.runOnce() con las piezas reales de abajo.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig, type ParsedConfig } from "../config/config";
import { resolvePaths, type ConnectorPaths } from "../config/paths";
import { CloudClient } from "../cloud/cloud-client";
import { resolveCloudUrl } from "../cloud/cloud-module";
import { createCredentialStore } from "../cloud/credential-store";
import { createLogger, type Logger } from "../log/logger";
import { writeFileAtomic } from "../storage/atomic-file";
import { CONNECTOR_VERSION } from "../version";
import { embeddedUpdateKey } from "./update-key";
import { resolveUpdaterPaths, updateSignalPaths, type UpdaterPaths } from "./update-paths";
import { writePause } from "./update-signals";
import { loadState, shouldCheck, Updater, type LocalStatus, type UpdateOfferResponse } from "./updater";

const LOCK_STALE_MS = 2 * 3600 * 1000;

async function runningInsideSea(): Promise<boolean> {
  try {
    const sea = (await import("node:sea")) as { isSea?: () => boolean };
    return typeof sea.isSea === "function" && sea.isSea();
  } catch {
    return false;
  }
}

/** Lanzador: copia el ejecutable a la carpeta del actualizador y arranca la copia. */
export async function launchUpdater(updater: UpdaterPaths, version: string): Promise<string> {
  await fs.mkdir(updater.binDir, { recursive: true });
  const target = path.join(updater.binDir, `scale-connect-updater-${version.replace(/[^0-9A-Za-z.-]/g, "_")}.exe`);
  await fs.copyFile(process.execPath, target);
  const child = spawn(target, ["--update-run", "--installed-version", version], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return target;
}

/** Borra copias viejas del actualizador (la que corre está en uso y Windows no la deja borrar: se ignora). */
async function cleanupBin(updater: UpdaterPaths, keep: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await fs.readdir(updater.binDir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(updater.binDir, name);
    if (path.resolve(file) !== path.resolve(keep)) await fs.rm(file, { force: true }).catch(() => undefined);
  }
}

/** Una sola corrida a la vez. */
export async function acquireLock(file: string, now = new Date()): Promise<boolean> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { pid?: number; at?: string };
    const fresh = typeof raw.at === "string" && now.getTime() - Date.parse(raw.at) < LOCK_STALE_MS;
    let alive = false;
    if (typeof raw.pid === "number") {
      try {
        process.kill(raw.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (fresh && alive) return false;
  } catch {
    // no hay lock
  }
  await writeFileAtomic(file, JSON.stringify({ pid: process.pid, at: now.toISOString() }));
  return true;
}

export function parseLocalStatus(body: unknown): LocalStatus | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, any>;
  if (typeof b.version !== "string") return null;
  const cloud = typeof b.cloud === "object" && b.cloud !== null ? b.cloud : {};
  const current = Array.isArray(cloud.currentJobs) ? cloud.currentJobs.length : 0;
  const journal = typeof b.jobs?.running === "number" ? b.jobs.running : 0;
  return {
    version: b.version,
    runningJobs: current + journal,
    cloudState: typeof cloud.state === "string" ? cloud.state : null,
    lastHeartbeatAt: typeof cloud.lastHeartbeatAt === "string" ? cloud.lastHeartbeatAt : null,
  };
}

async function getLocalStatus(port: number): Promise<LocalStatus | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return parseLocalStatus(await res.json());
  } catch {
    return null;
  }
}

/** Baja con tope de tamaño (el manifiesto dice cuánto pesa; nunca se lee más de eso). */
export async function downloadLimited(url: string, maxBytes: number, doFetch: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await doFetch(url, { signal: AbortSignal.timeout(15 * 60_000), redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`No se pudo bajar el instalador (HTTP ${res.status}).`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error("El instalador es más grande que lo que dice el manifiesto.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("El instalador es más grande que lo que dice el manifiesto.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function runProcess(file: string, args: string[], timeoutMs = 20 * 60_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/**
 * La carpeta de datos la puede escribir el servicio: lo que SYSTEM lee de ahí no puede pasar por un enlace (symlink o
 * junction, que el servicio podría crear) y nunca se escribe ni se borra nada ahí.
 */
export async function isPlainPath(file: string, stopAt: string): Promise<boolean> {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    try {
      if ((await fs.lstat(p)).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    if (path.resolve(p) === path.resolve(stopAt) || path.dirname(p) === p) return true;
  }
}

/** config.json SOLO leído (loadConfig crearía uno de fábrica si falta: el actualizador no escribe en los datos). */
export async function readConfigSafely(paths: ConnectorPaths): Promise<ParsedConfig["config"]> {
  if (!(await isPlainPath(paths.configFile, paths.root))) return parseConfig({}).config;
  try {
    return parseConfig(JSON.parse(await fs.readFile(paths.configFile, "utf8"))).config;
  } catch {
    return parseConfig({}).config;
  }
}

async function cloudFor(paths: ConnectorPaths, env: Record<string, string | undefined>) {
  const config = await readConfigSafely(paths);
  const url = resolveCloudUrl(config.cloud, env);
  const credentialOk = await isPlainPath(paths.credentialFile, paths.root);
  const store = createCredentialStore(paths.credentialFile);
  return {
    config,
    client: url && credentialOk ? new CloudClient({ baseUrl: url, userAgent: `PatagoniaScaleConnect-Updater/${CONNECTOR_VERSION}` }) : null,
    store,
  };
}

/** ¿El servicio dejó un pedido después de la última revisión? Solo se mira la fecha del archivo. */
async function requestedSince(file: string, lastCheckAt: string | null): Promise<boolean> {
  try {
    const st = await fs.stat(file);
    const last = lastCheckAt ? Date.parse(lastCheckAt) : 0;
    return st.isFile() && st.mtimeMs > (Number.isNaN(last) ? 0 : last);
  } catch {
    return false;
  }
}

export async function runUpdateCommand(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const dev = argv.includes("--dev");
  const updaterPaths = resolveUpdaterPaths({ dev, env, cwd: process.cwd() });

  // Lanzador (desde Program Files). En desarrollo, o fuera del ejecutable, corre directo.
  if (argv.includes("--update") && !argv.includes("--update-run") && (await runningInsideSea())) {
    await launchUpdater(updaterPaths, CONNECTOR_VERSION);
    return 0;
  }

  const paths = resolvePaths({ dev, env, cwd: process.cwd() });
  const logger: Logger = createLogger({ dir: updaterPaths.logsDir, level: "info", maxBytes: 2 * 1024 * 1024, maxFiles: 3, console: dev });
  const iv = argv.indexOf("--installed-version");
  const installedVersion = iv >= 0 && argv[iv + 1] ? argv[iv + 1] : CONNECTOR_VERSION;
  const signals = updateSignalPaths(paths.root, updaterPaths.root);

  const state = await loadState(updaterPaths.stateFile);
  const requested = await requestedSince(signals.requestFile, state.lastCheckAt);
  const decision = shouldCheck({ requested, lastCheckAt: state.lastCheckAt, now: new Date(), uptimeSec: os.uptime() });
  if (!decision.run && !argv.includes("--forzar")) return 0;
  if (!(await acquireLock(updaterPaths.lockFile))) {
    logger.info("Ya hay una actualización en curso");
    return 0;
  }
  try {
    const key = embeddedUpdateKey();
    const { config, client, store } = await cloudFor(paths, env);
    const credential = client ? await store.load().catch(() => null) : null;
    const cred = credential ? { connectorId: credential.connectorId, secret: credential.secret } : null;
    logger.info("Revisa si hay versión nueva", { reason: decision.reason, installed: installedVersion, key: key.keyId });

    const updater = new Updater({
      publicKey: key.key,
      installedVersion,
      paths: updaterPaths,
      logger,
      getOffer: async (current): Promise<UpdateOfferResponse | null> => (client && cred ? client.updateOffer(cred, current) : null),
      download: (url, max) => downloadLimited(url, max),
      getStatus: () => getLocalStatus(config.http.port),
      runInstaller: (file, args) => runProcess(file, args),
      setPause: (until, version) => writePause(signals, until, version),
      report: async (result) => {
        await writeFileAtomic(signals.resultFile, `${JSON.stringify(result, null, 2)}\n`).catch(() => undefined);
        if (client && cred) await client.reportUpdate(cred, { ...result });
      },
    });
    const result = await updater.runOnce();
    // También lo que no se informa a la nube queda a la vista en /status.
    await writeFileAtomic(signals.resultFile, `${JSON.stringify(result, null, 2)}\n`).catch(() => undefined);
    await cleanupBin(updaterPaths, process.execPath);
    return result.result === "fallo_reversion" || result.result === "error" ? 1 : 0;
  } finally {
    await fs.rm(updaterPaths.lockFile, { force: true }).catch(() => undefined);
  }
}
