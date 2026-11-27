import test from "node:test";
import assert from "node:assert/strict";
import { CloudAgent } from "./cloud-agent";
import { CloudClient } from "./cloud-client";
import { MemoryCredentialStore } from "./credential-store";
import type { CloudJob, JobContext, JobExecutor, JobOutcome } from "./job-executor";
import { FakeCloud } from "./test-fake-cloud";
import { createMemoryLogger } from "../log/logger";

const FP = "e".repeat(64);

async function waitFor(check: () => boolean, timeoutMs = 3000, what = "condición") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`No se cumplió a tiempo: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Ejecutor falso: manda cada producto, avisa el avance de a uno y puede fallar o colgarse. */
class FakeExecutor implements JobExecutor {
  readonly seen: CloudJob[] = [];
  behaviour: "ok" | "throw" | "wait-abort" = "ok";
  aborted = 0;

  async execute(job: CloudJob, ctx: JobContext): Promise<JobOutcome> {
    this.seen.push(job);
    if (this.behaviour === "throw") throw new Error("se rompió el puerto");
    if (this.behaviour === "wait-abort") {
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      this.aborted += 1;
      return { status: "failed", errorCode: "cortado", items: [] };
    }
    const products = (job.payload.products as Array<{ plu: string }>) ?? [];
    let done = 0;
    for (const p of products) {
      done += 1;
      await ctx.progress({ done, total: products.length, text: p.plu, items: [{ plu: p.plu, action: "write", status: "confirmed" }] });
    }
    return { status: "done", items: [] };
  }
}

function setup(cloud: FakeCloud, store = new MemoryCredentialStore(), executor = new FakeExecutor()) {
  const logger = createMemoryLogger();
  const agent = new CloudAgent({
    client: new CloudClient({ baseUrl: cloud.baseUrl }),
    store,
    executor,
    version: "0.3.0",
    seenScales: () => [{ key: "kretz-1", name: "Report", online: true }],
    fingerprint: async () => FP,
    logger,
    heartbeatMs: 50,
    pollWaitSec: 1,
    backoffMs: [20, 40, 80],
    minPollGapMs: 10,
    finishAttempts: 50,
  });
  return { agent, store, executor, logger };
}

test("sin dirección de la nube no hace nada y lo dice", async () => {
  const agent = new CloudAgent({ client: null, store: new MemoryCredentialStore(), executor: new FakeExecutor(), version: "1", seenScales: () => [], fingerprint: async () => null });
  await agent.start();
  assert.equal(agent.status().state, "sin_configurar");
  assert.deepEqual(await agent.pair({ code: "ABCDEFGH", name: "Caja" }), { kind: "error", error: "no_configurado" });
});

test("vincula, guarda la credencial, late, toma un trabajo y lo cierra con el resultado por producto", async (t) => {
  const cloud = new FakeCloud();
  await cloud.start();
  const { agent, store, executor } = setup(cloud);
  t.after(async () => {
    await agent.stop();
    await cloud.stop();
  });
  await agent.start();
  assert.equal(agent.status().state, "sin_vincular");

  cloud.addCode("ABCDEFGH");
  const r = await agent.pair({ code: "abcd-efgh", name: "Caja 1" });
  assert.equal(r.kind, "paired");
  // El secreto nunca vuelve por la respuesta del agente (va a la página local).
  assert.equal(r.kind === "paired" && r.secret, "[guardado]");
  const saved = await store.load();
  assert.ok(saved && saved.secret.length >= 43 && saved.name === "Caja 1");
  assert.equal(JSON.stringify(agent.status()).includes(saved!.secret), false, "el estado no muestra el secreto");

  await waitFor(() => agent.status().state === "en_linea", 3000, "en línea");
  const conn = cloud.connectors.get(saved!.connectorId)!;
  await waitFor(() => conn.version === "0.3.0" && conn.scales.length === 1, 3000, "latido con versión y balanzas");

  const job = cloud.queueJob({ scaleKey: "kretz-1", payload: { products: [{ plu: "1" }, { plu: "2" }, { plu: "3" }] } });
  await waitFor(() => job.status === "done", 3000, "trabajo cerrado");
  assert.equal(executor.seen[0].id, job.id);
  assert.deepEqual(job.items.map((i) => i.plu), ["1", "2", "3"]);
  assert.equal(job.progressSeq, 3);
  await waitFor(() => agent.status().jobsDone === 1, 3000, "contador de trabajos");
  assert.deepEqual(await agent.pair({ code: "X", name: "Y" }), { kind: "error", error: "ya_vinculada" });
});

test("si el ejecutor falla, el trabajo se cierra como fallido (no queda colgado)", async (t) => {
  const cloud = new FakeCloud();
  await cloud.start();
  const executor = new FakeExecutor();
  executor.behaviour = "throw";
  const { agent } = setup(cloud, undefined, executor);
  t.after(async () => {
    await agent.stop();
    await cloud.stop();
  });
  cloud.addCode("ABCDEFGH");
  await agent.pair({ code: "ABCDEFGH", name: "Caja 1" });
  const job = cloud.queueJob({ scaleKey: "kretz-1" });
  await waitFor(() => job.status === "failed", 3000, "cerrado fallido");
  assert.equal(job.error, "error_conector");
});

test("reconexión: se corta internet, reintenta con espera creciente y sigue sola", async (t) => {
  const cloud = new FakeCloud();
  await cloud.start();
  const { agent } = setup(cloud);
  t.after(async () => {
    await agent.stop();
    await cloud.stop();
  });
  cloud.addCode("ABCDEFGH");
  await agent.pair({ code: "ABCDEFGH", name: "Caja 1" });
  await waitFor(() => agent.status().state === "en_linea");

  cloud.mode = "down";
  await waitFor(() => agent.status().state === "sin_conexion", 3000, "sin conexión");
  await waitFor(() => (agent.status().reconnectAttempt as number) >= 2, 3000, "varios reintentos");
  // Y también con la nube respondiendo 503.
  cloud.mode = "error503";
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(agent.status().state, "sin_conexion");
  assert.equal(agent.status().paired, true, "un corte no desvincula");

  cloud.mode = "up";
  await waitFor(() => agent.status().state === "en_linea", 3000, "vuelve en línea");
  const job = cloud.queueJob({ scaleKey: "kretz-1", payload: { products: [{ plu: "9" }] } });
  await waitFor(() => job.status === "done", 3000, "trabaja después del corte");
});

test("reconexión con el cierre pendiente: el resultado llega cuando vuelve la conexión", async (t) => {
  const cloud = new FakeCloud();
  await cloud.start();
  const executor = new FakeExecutor();
  const { agent } = setup(cloud, undefined, executor);
  t.after(async () => {
    await agent.stop();
    await cloud.stop();
  });
  cloud.addCode("ABCDEFGH");
  await agent.pair({ code: "ABCDEFGH", name: "Caja 1" });
  await waitFor(() => agent.status().state === "en_linea");

  // El ejecutor corta la nube a mitad del trabajo: el avance no llega, el cierre se reintenta.
  const original = executor.execute.bind(executor);
  executor.execute = async (job, ctx) => {
    cloud.mode = "down";
    const out = await original(job, ctx);
    setTimeout(() => (cloud.mode = "up"), 150);
    return out;
  };
  const job = cloud.queueJob({ scaleKey: "kretz-1", payload: { products: [{ plu: "1" }, { plu: "2" }] } });
  await waitFor(() => job.status === "done", 5000, "cerrado tras volver");
  assert.deepEqual(job.items.map((i) => i.plu).sort(), ["1", "2"], "los productos sin informar viajan con el cierre");
});

test("revocada: corta el trabajo en curso, borra la credencial y vuelve a pedir código", async (t) => {
  const cloud = new FakeCloud();
  await cloud.start();
  const executor = new FakeExecutor();
  executor.behaviour = "wait-abort";
  const { agent, store } = setup(cloud, undefined, executor);
  t.after(async () => {
    await agent.stop();
    await cloud.stop();
  });
  cloud.addCode("ABCDEFGH");
  await agent.pair({ code: "ABCDEFGH", name: "Caja 1" });
  const saved = await store.load();
  const job = cloud.queueJob({ scaleKey: "kretz-1" });
  await waitFor(() => job.status === "running", 3000, "trabajo tomado");

  cloud.revoke(saved!.connectorId);
  await waitFor(() => agent.status().state === "desvinculada", 3000, "desvinculada");
  await waitFor(() => executor.aborted === 1, 3000, "trabajo cortado");
  assert.equal(await store.load(), null, "credencial borrada");
  assert.equal(agent.isPaired, false);
  const callsAfter = cloud.calls.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cloud.calls.length, callsAfter, "no sigue llamando con la credencial revocada");
});

test("reinstalación: misma huella → ¿Es Caja 1? → recupera la misma PC", async (t) => {
  const cloud = new FakeCloud();
  await cloud.start();
  const first = setup(cloud);
  cloud.addCode("ABCDEFGH");
  await first.agent.pair({ code: "ABCDEFGH", name: "Caja 1" });
  const old = await first.store.load();
  await first.agent.stop();

  // Se reinstaló: credencial nueva vacía, misma huella.
  const second = setup(cloud);
  t.after(async () => {
    await second.agent.stop();
    await cloud.stop();
  });
  await second.agent.start();
  cloud.addCode("JKLMNPQR");
  const ask = await second.agent.pair({ code: "JKLMNPQR", name: "Caja nueva" });
  assert.equal(ask.kind, "choose");
  assert.equal(ask.kind === "choose" && ask.candidates[0].name, "Caja 1");
  assert.equal(second.agent.isPaired, false);
  const rec = await second.agent.pair({ code: "JKLMNPQR", name: "", recoverId: old!.connectorId });
  assert.equal(rec.kind === "paired" && rec.recovered, true);
  const now = await second.store.load();
  assert.equal(now!.connectorId, old!.connectorId);
  assert.notEqual(now!.secret, old!.secret);
  await waitFor(() => second.agent.status().state === "en_linea");
});
