// Lado del servicio de la actualización: pedido al actualizador, pausa de trabajos y la oferta que trae la nube.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudAgent } from "../cloud/cloud-agent";
import { CloudClient } from "../cloud/cloud-client";
import { MemoryCredentialStore } from "../cloud/credential-store";
import type { CloudJob, JobContext, JobExecutor, JobOutcome } from "../cloud/job-executor";
import { FakeCloud } from "../cloud/test-fake-cloud";
import { updateSignalPaths } from "./update-paths";
import { MAX_PAUSE_MS, UpdateSignals, writePause } from "./update-signals";

function tmp(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sc-signals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(check: () => boolean, timeoutMs = 3000, what = "condición") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`No se cumplió a tiempo: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("deja el pedido solo si la versión ofrecida es más nueva, y una vez por versión", async (t) => {
  const paths = updateSignalPaths(tmp(t), tmp(t));
  const s = new UpdateSignals({ paths, currentVersion: "0.2.1", enabled: true });
  for (const v of [null, "0.2.0", "0.2.1", "basura"]) {
    await s.onOffer(v);
    await assert.rejects(fs.access(paths.requestFile), `no pide por ${v}`);
  }
  await s.onOffer("0.3.0");
  assert.equal(JSON.parse(await fs.readFile(paths.requestFile, "utf8")).version, "0.3.0");
  await fs.rm(paths.requestFile);
  await s.onOffer("0.3.0");
  await assert.rejects(fs.access(paths.requestFile), "la misma versión no se vuelve a pedir");
  assert.equal(s.status().requested, "0.3.0");
});

test("sin clave embebida no pide nada y /status dice por qué", async (t) => {
  const paths = updateSignalPaths(tmp(t), tmp(t));
  const s = new UpdateSignals({ paths, currentVersion: "0.2.1", enabled: false, disabledReason: "sin clave" });
  await s.onOffer("9.0.0");
  await assert.rejects(fs.access(paths.requestFile));
  assert.equal(s.status().enabled, false);
  assert.equal(s.status().disabledReason, "sin clave");
});

test("pausa: vale mientras no venza y nunca más de una hora aunque el archivo diga otra cosa", async (t) => {
  const paths = updateSignalPaths(tmp(t), tmp(t));
  let now = Date.parse("2026-11-27T12:00:00Z");
  const s = new UpdateSignals({ paths, currentVersion: "0.2.1", enabled: true, now: () => new Date(now) });
  assert.equal(await s.claimsPaused(), false);
  await writePause(paths, new Date(now + 30 * 365 * 24 * 3600_000), "0.3.0", new Date(now));
  now += 10_000;
  assert.equal(await s.claimsPaused(), true);
  now += MAX_PAUSE_MS;
  assert.equal(await s.claimsPaused(), false, "si el actualizador se cortó y dejó el archivo, a la hora sigue solo");
  await writePause(paths, new Date(now - 1000), "0.3.0", new Date(now));
  now += 10_000;
  assert.equal(await s.claimsPaused(), false, "una pausa vencida no frena");
  await fs.writeFile(paths.pauseFile, "{no es json");
  now += 10_000;
  assert.equal(await s.claimsPaused(), false, "un archivo roto no frena");
});

class CountingExecutor implements JobExecutor {
  readonly seen: CloudJob[] = [];
  async execute(job: CloudJob, _ctx: JobContext): Promise<JobOutcome> {
    this.seen.push(job);
    return { status: "done", items: [] };
  }
}

test("con la pausa del actualizador el agente no toma trabajos nuevos; al levantarla, sí", async (t) => {
  const cloud = new FakeCloud();
  await cloud.start();
  let paused = true;
  const executor = new CountingExecutor();
  const agent = new CloudAgent({
    client: new CloudClient({ baseUrl: cloud.baseUrl }),
    store: new MemoryCredentialStore(),
    executor,
    version: "0.2.1",
    seenScales: () => [{ key: "kretz-1", name: "Report", online: true }],
    fingerprint: async () => "e".repeat(64),
    heartbeatMs: 50,
    pollWaitSec: 1,
    backoffMs: [20, 40],
    minPollGapMs: 10,
    claimsPaused: () => paused,
    pausePollMs: 20,
  });
  t.after(async () => {
    await agent.stop();
    await cloud.stop();
  });
  await agent.start();
  cloud.addCode("ABCDEFGH");
  assert.equal((await agent.pair({ code: "ABCDEFGH", name: "Caja 1" })).kind, "paired");
  await waitFor(() => agent.status().state === "en_linea", 3000, "en línea");
  const job = cloud.queueJob({ scaleKey: "kretz-1", payload: { products: [] } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(job.status, "queued", "en pausa queda en la cola de la nube");
  assert.equal(cloud.calls.filter((c) => c.endsWith("/claim")).length, 0);
  paused = false;
  await waitFor(() => job.status === "done", 3000, "tomado después de la pausa");
  assert.equal(executor.seen.length, 1);
});

test("cliente: la configuración trae la versión ofrecida y /update la oferta con el manifiesto", async (t) => {
  const cloud = new FakeCloud();
  await cloud.start();
  t.after(() => cloud.stop());
  cloud.addCode("ABCDEFGH");
  const client = new CloudClient({ baseUrl: cloud.baseUrl });
  const paired = await client.pair({ code: "ABCDEFGH", name: "Caja 1", fingerprint: null, version: "0.2.1" });
  assert.equal(paired.kind, "paired");
  const cred = paired.kind === "paired" ? { connectorId: paired.connectorId, secret: paired.secret } : (null as never);
  assert.equal((await client.config(cred)).updateVersion, null);
  assert.deepEqual(await client.updateOffer(cred, "0.2.1"), { channel: "stable", offer: null });

  cloud.updateOffer = { version: "0.3.0", manifest: { version: "0.3.0", signature: "x" } };
  cloud.updateChannel = "pilot";
  assert.equal((await client.config(cred)).updateVersion, "0.3.0");
  const offer = await client.updateOffer(cred, "0.2.1");
  assert.equal(offer.channel, "pilot");
  assert.equal(offer.offer?.version, "0.3.0");
  assert.deepEqual(cloud.updateRequests.at(-1), { current_version: "0.2.1" });
  await client.reportUpdate(cred, { result: "instalada", from: "0.2.1", to: "0.3.0" });
  assert.equal(cloud.updateReports[0].result, "instalada");
});
