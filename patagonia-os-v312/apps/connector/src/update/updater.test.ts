// Actualizador: firma, hash, bajada de versión, clave ausente, espera de trabajos, instalación y vuelta atrás.
// No se ejecuta ningún instalador real: el "instalador" es un JSON que interpreta un script de Node falso
// (testing/fake-installer.mjs), corrido como proceso aparte igual que el de verdad.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSignedManifest } from "../../scripts/lib/update-manifest.mjs";
import { resolveUpdaterPaths, updateSignalPaths } from "./update-paths";
import { loadState, shouldCheck, Updater, type LocalStatus, type UpdaterDeps, type UpdateResult } from "./updater";
import { parseUpdateKey } from "./update-key";
import { writePause } from "./update-signals";
import { acquireLock, downloadLimited, isPlainPath, parseLocalStatus, readConfigSafely } from "./updater-run";
import { resolvePaths } from "../config/paths";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_INSTALLER = path.join(here, "testing", "fake-installer.mjs");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");

/** "Instalador" = JSON con lo que hace al correr: qué versión deja y si el servicio levanta. */
function installerBytes(spec: { version: string; exit?: number; starts?: boolean }): Buffer {
  return Buffer.from(JSON.stringify({ exit: 0, starts: true, ...spec }));
}

function manifestFor(bytes: Buffer, version: string, opts: { key?: KeyObject; channel?: string; minVersion?: string } = {}) {
  return createSignedManifest(
    {
      version,
      channel: opts.channel ?? "general",
      minVersion: opts.minVersion ?? "0.1.0",
      url: `https://xyz.supabase.co/storage/v1/object/public/scale-connect/${version}/PatagoniaScaleConnect-Setup-${version}.exe`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    },
    opts.key ?? privateKey,
  );
}

interface Harness {
  deps: UpdaterDeps;
  dir: string;
  service: { file: string };
  installs: string[];
  reports: UpdateResult[];
  pauses: Array<string | null>;
  statusCalls: number;
}

/** El "servicio" es un archivo: el instalador falso escribe ahí la versión que quedó corriendo. */
async function harness(t: test.TestContext, input: {
  installed?: string;
  offer?: { bytes: Buffer; manifest: unknown } | null;
  download?: Buffer;
  channel?: "pilot" | "stable";
  busyPolls?: number;
  key?: KeyObject | null;
  noBackup?: boolean;
}): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sc-updater-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = resolveUpdaterPaths({ dev: false, env: { PATAGONIA_UPDATER_HOME: path.join(dir, "upd") }, cwd: dir });
  const installed = input.installed ?? "0.2.1";
  const serviceFile = path.join(dir, "servicio.json");
  await fs.writeFile(serviceFile, JSON.stringify({ version: installed }));
  await fs.mkdir(paths.installersDir, { recursive: true });
  if (!input.noBackup) await fs.writeFile(paths.currentInstaller, installerBytes({ version: installed }));
  const h: Harness = { dir, service: { file: serviceFile }, installs: [], reports: [], pauses: [], statusCalls: 0, deps: undefined as never };
  let clock = Date.parse("2026-11-27T12:00:00Z");
  let busy = input.busyPolls ?? 0;
  h.deps = {
    publicKey: input.key === undefined ? publicKey : input.key,
    installedVersion: installed,
    paths,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    getOffer: async () => ({ channel: input.channel ?? "stable", offer: input.offer ? { version: "x", manifest: input.offer.manifest } : null }),
    download: async () => input.download ?? input.offer!.bytes,
    getStatus: async (): Promise<LocalStatus | null> => {
      h.statusCalls += 1;
      let s: { version?: string } = {};
      try {
        s = JSON.parse(await fs.readFile(serviceFile, "utf8"));
      } catch {
        return null;
      }
      if (!s.version) return null;
      const running = busy > 0 ? 1 : 0;
      if (busy > 0) busy -= 1;
      return { version: s.version, runningJobs: running, cloudState: "en_linea", lastHeartbeatAt: new Date(clock).toISOString() };
    },
    runInstaller: (file, args) =>
      new Promise((resolve, reject) => {
        h.installs.push(path.basename(file));
        assert.deepEqual(args.slice(0, 3), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]);
        assert.ok(!args.some((a) => /^\/NUBE/i.test(a)), "nunca cambia la nube");
        const child = spawn(process.execPath, [FAKE_INSTALLER, file, serviceFile], { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? -1));
      }),
    setPause: async (until) => {
      h.pauses.push(until ? until.toISOString() : null);
    },
    report: async (r) => {
      h.reports.push(r);
    },
    idlePollMs: 15_000,
    healthPollMs: 5_000,
  };
  return h;
}

test("sin clave pública embebida la actualización queda apagada (falla cerrada)", async (t) => {
  const bytes = installerBytes({ version: "0.3.0" });
  const h = await harness(t, { offer: { bytes, manifest: manifestFor(bytes, "0.3.0") }, key: null });
  let asked = false;
  h.deps.getOffer = async () => {
    asked = true;
    return null;
  };
  const r = await new Updater(h.deps).runOnce();
  assert.equal(r.result, "apagada");
  assert.equal(asked, false, "ni siquiera pide la oferta");
  assert.deepEqual(h.installs, []);
  assert.deepEqual(parseUpdateKey("").key, null);
  assert.match(parseUpdateKey("no-es-una-clave").disabledReason ?? "", /inválida/);
  const der = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.ok(parseUpdateKey(der).key, "acepta el DER en base64 (la variable del CI)");
});

test("firma válida + hash correcto: espera, instala en silencio y comprueba que la nueva levantó", async (t) => {
  const bytes = installerBytes({ version: "0.3.0" });
  const h = await harness(t, { offer: { bytes, manifest: manifestFor(bytes, "0.3.0") } });
  const r = await new Updater(h.deps).runOnce();
  assert.equal(r.result, "instalada", r.message);
  assert.deepEqual(h.installs, ["PatagoniaScaleConnect-Setup-0.3.0.exe"]);
  const state = await loadState(h.deps.paths.stateFile);
  assert.deepEqual(state.installed, { version: "0.3.0" });
  assert.equal(state.previous?.version, "0.2.1", "la anterior queda guardada para volver atrás");
  assert.equal(await fs.readFile(h.deps.paths.previousInstaller, "utf8"), installerBytes({ version: "0.2.1" }).toString());
  assert.equal(await fs.readFile(h.deps.paths.currentInstaller, "utf8"), bytes.toString());
  assert.equal(h.pauses.at(-1), null, "la pausa se levanta");
  assert.equal(h.reports.at(-1)?.result, "instalada");
});

test("firma inválida, de otra clave o manifiesto tocado: no baja ni instala nada", async (t) => {
  const bytes = installerBytes({ version: "0.3.0" });
  const cases: Array<[string, unknown]> = [
    ["otra clave", manifestFor(bytes, "0.3.0", { key: other.privateKey })],
    ["url cambiada", { ...manifestFor(bytes, "0.3.0"), url: "https://malo.example/x.exe" }],
    ["sha cambiado", { ...manifestFor(bytes, "0.3.0"), sha256: "b".repeat(64) }],
    ["sin firma", { ...manifestFor(bytes, "0.3.0"), signature: "" }],
  ];
  for (const [label, manifest] of cases) {
    const h = await harness(t, { offer: { bytes, manifest } });
    let downloaded = false;
    h.deps.download = async () => {
      downloaded = true;
      return bytes;
    };
    const r = await new Updater(h.deps).runOnce();
    assert.equal(r.result, "rechazada", label);
    assert.equal(downloaded, false, label);
    assert.deepEqual(h.installs, [], label);
  }
});

test("el instalador bajado distinto del firmado (hash o tamaño) no se ejecuta", async (t) => {
  const bytes = installerBytes({ version: "0.3.0" });
  for (const download of [installerBytes({ version: "0.3.0", starts: false }), Buffer.concat([bytes, Buffer.from(" ")])]) {
    const h = await harness(t, { offer: { bytes, manifest: manifestFor(bytes, "0.3.0") }, download });
    const r = await new Updater(h.deps).runOnce();
    assert.equal(r.result, "rechazada");
    assert.match(r.message, /SHA-256|bytes/);
    assert.deepEqual(h.installs, []);
    assert.equal(h.statusCalls, 0, "ni siquiera frena trabajos");
  }
});

test("nunca baja de versión ni reinstala la misma por una oferta (aunque esté bien firmada)", async (t) => {
  for (const version of ["0.2.0", "0.2.1"]) {
    const bytes = installerBytes({ version });
    const h = await harness(t, { installed: "0.2.1", offer: { bytes, manifest: manifestFor(bytes, version) } });
    const r = await new Updater(h.deps).runOnce();
    assert.equal(r.result, "rechazada", version);
    assert.match(r.message, /nunca se baja/);
    assert.deepEqual(h.installs, []);
  }
  // versión mínima: la instalada es más vieja que minVersion → a mano.
  const bytes = installerBytes({ version: "0.5.0" });
  const h = await harness(t, { installed: "0.2.1", offer: { bytes, manifest: manifestFor(bytes, "0.5.0", { minVersion: "0.3.0" }) } });
  assert.equal((await new Updater(h.deps).runOnce()).result, "rechazada");
});

test("canal: una PC estable no instala un build firmado solo para piloto", async (t) => {
  const bytes = installerBytes({ version: "0.3.0" });
  const manifest = manifestFor(bytes, "0.3.0", { channel: "piloto" });
  const stable = await harness(t, { offer: { bytes, manifest }, channel: "stable" });
  assert.equal((await new Updater(stable.deps).runOnce()).result, "rechazada");
  const pilot = await harness(t, { offer: { bytes, manifest }, channel: "pilot" });
  assert.equal((await new Updater(pilot.deps).runOnce()).result, "instalada");
});

test("espera a que /status no tenga trabajos en curso antes de instalar", async (t) => {
  const bytes = installerBytes({ version: "0.3.0" });
  const h = await harness(t, { offer: { bytes, manifest: manifestFor(bytes, "0.3.0") }, busyPolls: 3 });
  const r = await new Updater(h.deps).runOnce();
  assert.equal(r.result, "instalada");
  assert.ok(h.statusCalls >= 4, "consultó /status hasta que se vació");
  assert.ok(h.pauses[0], "antes pidió al servicio no tomar trabajos nuevos");
});

test("si los trabajos siguen 30 minutos, no instala y lo deja para después", async (t) => {
  const bytes = installerBytes({ version: "0.3.0" });
  const h = await harness(t, { offer: { bytes, manifest: manifestFor(bytes, "0.3.0") }, busyPolls: 10_000 });
  const r = await new Updater(h.deps).runOnce();
  assert.equal(r.result, "ocupado");
  assert.deepEqual(h.installs, []);
  assert.equal(h.pauses.at(-1), null, "levanta la pausa");
  assert.ok(h.statusCalls >= 120 && h.statusCalls <= 125, `cada 15 s durante 30 min (${h.statusCalls})`);
});

test("si la nueva no levanta, reinstala la anterior guardada, bloquea esa versión y lo informa", async (t) => {
  const bytes = installerBytes({ version: "0.3.0", starts: false });
  const h = await harness(t, { offer: { bytes, manifest: manifestFor(bytes, "0.3.0") } });
  const r = await new Updater(h.deps).runOnce();
  assert.equal(r.result, "revertida", r.message);
  assert.deepEqual(h.installs, ["PatagoniaScaleConnect-Setup-0.3.0.exe", "anterior.exe"]);
  assert.equal(JSON.parse(await fs.readFile(h.service.file, "utf8")).version, "0.2.1", "quedó la anterior andando");
  assert.equal(h.reports.at(-1)?.result, "revertida");
  const state = await loadState(h.deps.paths.stateFile);
  assert.ok(state.blocked["0.3.0"]);
  assert.deepEqual(state.installed, { version: "0.2.1" });
  // La próxima corrida no vuelve a intentar la misma.
  const again = await new Updater(h.deps).runOnce();
  assert.equal(again.result, "bloqueada");
  assert.equal(h.installs.length, 2);
});

test("si el instalador nuevo termina con error también vuelve atrás", async (t) => {
  const bytes = installerBytes({ version: "0.3.0", exit: 5 });
  const h = await harness(t, { offer: { bytes, manifest: manifestFor(bytes, "0.3.0") } });
  const r = await new Updater(h.deps).runOnce();
  assert.equal(r.result, "revertida");
  assert.match(r.message, /código 5/);
});

test("si el instalador guardado de la anterior fue cambiado, no lo ejecuta (fallo_reversion)", async (t) => {
  const bytes = installerBytes({ version: "0.3.0", starts: false });
  const h = await harness(t, { offer: { bytes, manifest: manifestFor(bytes, "0.3.0") } });
  const real = h.deps.runInstaller;
  h.deps.runInstaller = async (file, args) => {
    const code = await real(file, args);
    // Alguien cambió anterior.exe mientras se instalaba la nueva.
    await fs.writeFile(h.deps.paths.previousInstaller, installerBytes({ version: "9.9.9" }));
    return code;
  };
  const r = await new Updater(h.deps).runOnce();
  assert.equal(r.result, "fallo_reversion");
  assert.match(r.message, /no coincide/);
  assert.deepEqual(h.installs, ["PatagoniaScaleConnect-Setup-0.3.0.exe"]);
});

test("sin el instalador de la versión actual no actualiza (no podría volver atrás)", async (t) => {
  const bytes = installerBytes({ version: "0.3.0" });
  const h = await harness(t, { offer: { bytes, manifest: manifestFor(bytes, "0.3.0") }, noBackup: true });
  assert.equal((await new Updater(h.deps).runOnce()).result, "sin_respaldo");
  assert.deepEqual(h.installs, []);
});

test("sin oferta o sin vincular no hace nada ni molesta a la nube", async (t) => {
  const h = await harness(t, { offer: null });
  assert.equal((await new Updater(h.deps).runOnce()).result, "sin_oferta");
  h.deps.getOffer = async () => null;
  assert.equal((await new Updater(h.deps).runOnce()).result, "sin_nube");
  assert.deepEqual(h.reports, []);
});

test("cuándo revisa: pedido del servicio, arranque de Windows o cada 6 horas", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
  assert.equal(shouldCheck({ requested: false, lastCheckAt: null, now, uptimeSec: 99_999 }).run, true);
  assert.equal(shouldCheck({ requested: true, lastCheckAt: ago(0.1), now, uptimeSec: 99_999 }).run, true);
  assert.equal(shouldCheck({ requested: false, lastCheckAt: ago(1), now, uptimeSec: 99_999 }).run, false);
  assert.equal(shouldCheck({ requested: false, lastCheckAt: ago(6), now, uptimeSec: 99_999 }).run, true);
  assert.equal(shouldCheck({ requested: false, lastCheckAt: ago(1), now, uptimeSec: 600 }).reason, "arranque de Windows");
});

test("lee /status: trabajos en curso de la nube y del diario", () => {
  assert.deepEqual(parseLocalStatus({ version: "0.3.0", jobs: { running: 1 }, cloud: { state: "en_linea", currentJobs: [{ id: "a" }], lastHeartbeatAt: "x" } }), {
    version: "0.3.0",
    runningJobs: 2,
    cloudState: "en_linea",
    lastHeartbeatAt: "x",
  });
  assert.equal(parseLocalStatus({ ok: false }), null);
});

test("la descarga nunca lee más de lo que dice el manifiesto", async () => {
  const body = () => new Response(new Uint8Array(2000));
  await assert.rejects(downloadLimited("https://x/y", 1000, async () => body()), /más grande/);
  assert.equal((await downloadLimited("https://x/y", 2000, async () => body())).length, 2000);
});

test("una sola corrida a la vez (lock con pid vivo)", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sc-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "en-curso.json");
  assert.equal(await acquireLock(file), true);
  assert.equal(await acquireLock(file), false, "el pid de este proceso está vivo");
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, at: "2020-01-01T00:00:00Z" }));
  assert.equal(await acquireLock(file), true, "uno viejo se ignora");
});

test("pausa.json: la escribe el actualizador y la borra al terminar", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sc-pause-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const signals = updateSignalPaths(dir, dir);
  await writePause(signals, new Date("2026-11-27T13:00:00Z"), "0.3.0");
  assert.equal(JSON.parse(await fs.readFile(signals.pauseFile, "utf8")).version, "0.3.0");
  await writePause(signals, null, null);
  await assert.rejects(fs.access(signals.pauseFile));
});

test("lo que SYSTEM lee de la carpeta de datos no puede pasar por un enlace (junction) que haya puesto el servicio", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sc-junction-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, "datos");
  const elsewhere = path.join(dir, "otro-lado");
  await fs.mkdir(data, { recursive: true });
  await fs.mkdir(elsewhere, { recursive: true });
  await fs.writeFile(path.join(elsewhere, "config.json"), JSON.stringify({ cloud: { url: "https://malo.example/functions/v1" } }));
  await fs.writeFile(path.join(data, "config.json"), JSON.stringify({ http: { port: 9555 } }));
  const paths = resolvePaths({ dev: false, env: { PATAGONIA_CONNECT_HOME: data }, cwd: dir });
  assert.equal(await isPlainPath(paths.configFile, paths.root), true);
  assert.equal((await readConfigSafely(paths)).http.port, 9555);
  // El servicio pone un enlace a otro lado dentro de su carpeta.
  const link = path.join(data, "sub");
  await fs.symlink(elsewhere, link, "junction");
  assert.equal(await isPlainPath(path.join(link, "config.json"), data), false);
  assert.equal(await isPlainPath(path.join(link, "no-existe.json"), data), false);
});

test("el actualizador nunca escribe ni borra en la carpeta de datos del servicio (solo en la suya)", async () => {
  const src = await fs.readFile(path.join(here, "updater-run.ts"), "utf8");
  const writes = src.split(/\r?\n/).filter((l) => /writeFileAtomic\(|fs\.rm\(|fs\.writeFile\(|fs\.copyFile\(|fs\.rename\(/.test(l));
  assert.ok(writes.length > 0);
  for (const l of writes) assert.doesNotMatch(l, /requestFile|paths\.(configFile|credentialFile|root)/, l);
  assert.doesNotMatch(src, /loadConfig\(/, "loadConfig crea un config.json de fábrica si falta");
});
