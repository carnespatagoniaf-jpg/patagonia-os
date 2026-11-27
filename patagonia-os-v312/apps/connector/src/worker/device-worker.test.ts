import test from "node:test";
import assert from "node:assert/strict";
import { DeviceWorker, type DeviceWorkerOptions, type JobOutcome } from "./device-worker";
const codeOf = (o: JobOutcome<unknown>) => (o.status === "done" ? undefined : o.error.code);
const messageOf = (o: JobOutcome<unknown>) => (o.status === "done" ? "" : o.error.message);
import { DeviceRegistry } from "./device-registry";
import { backoffDelay, DEFAULT_BACKOFF_MS } from "./backoff";
import { FakeByteLink } from "../link/fake-byte-link";
import { PortManager, serialResource, tcpResource } from "../ports/port-manager";
import { MemoryJournalStorage, StoredJobJournal } from "../journal/job-journal";

const enc = (s: string) => Buffer.from(s, "latin1");
const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("no se cumplió a tiempo");
    await sleep(5);
  }
}

async function journal() {
  const storage = new MemoryJournalStorage();
  const j = new StoredJobJournal(storage);
  await j.open();
  return { journal: j, storage };
}

function fastOptions(pm: PortManager, extra: Partial<DeviceWorkerOptions> = {}): DeviceWorkerOptions {
  return { portManager: pm, backoffMs: [10, 20, 50], watchdogMs: 150, commandTimeoutMs: 80, waitReadyMs: 300, ...extra };
}

test("backoff: 1, 2, 5, 10 y 30 s, y se queda en 30", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map((n) => backoffDelay(n)), [1000, 2000, 5000, 10000, 30000, 30000, 30000]);
  assert.deepEqual(DEFAULT_BACKOFF_MS, [1000, 2000, 5000, 10000, 30000]);
  assert.equal(backoffDelay(-3), 1000);
});

test("trabajo normal: comando con respuesta, pasos anotados en el diario", async () => {
  const pm = new PortManager();
  const { journal: j } = await journal();
  const link = new FakeByteLink({ respond: (w) => `OK:${text(w)}\x04` });
  const worker = new DeviceWorker({ id: "b1", name: "Balanza 1", resource: serialResource("COM3"), createLink: () => link }, fastOptions(pm, { journal: j }));
  worker.start();
  const outcome = await worker.enqueue({
    id: "job-1",
    kind: "prueba",
    run: async (ctx) => {
      const r1 = await ctx.command(enc("A"), { until: (b) => b.includes(4) });
      await ctx.confirmStep("paso-A", { reply: text(r1) });
      const r2 = await ctx.command(enc("B"), { until: (b) => b.includes(4) });
      await ctx.confirmStep("paso-B");
      return [text(r1), text(r2)];
    },
  });
  assert.equal(outcome.status, "done");
  assert.deepEqual(outcome.status === "done" && outcome.result, ["OK:A\x04", "OK:B\x04"]);
  const record = j.get("job-1");
  assert.equal(record?.status, "done");
  assert.deepEqual(record?.steps.map((s) => s.key), ["paso-A", "paso-B"]);
  assert.equal(worker.status().jobsDone, 1);
  await worker.stop();
  assert.equal(pm.isTaken(serialResource("COM3")), false);
});

test("cola propia: un trabajo a la vez, en orden", async () => {
  const pm = new PortManager();
  const worker = new DeviceWorker({ id: "b1", name: "B1", resource: serialResource("COM3"), createLink: () => new FakeByteLink() }, fastOptions(pm));
  worker.start();
  let concurrent = 0;
  let maxConcurrent = 0;
  const order: number[] = [];
  const job = (n: number) =>
    worker.enqueue({
      kind: "cola",
      run: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(15);
        order.push(n);
        concurrent -= 1;
        return n;
      },
    });
  const results = await Promise.all([job(1), job(2), job(3)]);
  assert.deepEqual(results.map((r) => r.status), ["done", "done", "done"]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(maxConcurrent, 1);
  await worker.stop();
});

test("tiempo de espera por comando: falla el trabajo, el puerto sigue", async () => {
  const pm = new PortManager();
  const link = new FakeByteLink();
  link.hung = true;
  const worker = new DeviceWorker({ id: "b1", name: "B1", resource: serialResource("COM3"), createLink: () => link }, fastOptions(pm, { watchdogMs: 5000 }));
  worker.start();
  const outcome = await worker.enqueue({ kind: "x", run: (ctx) => ctx.command(enc("W"), { timeoutMs: 30 }) });
  assert.equal(outcome.status, "failed");
  assert.equal(codeOf(outcome), "timeout");
  assert.equal(worker.status().state, "ready");
  await worker.stop();
});

test("vigía: un trabajo colgado se aborta, se libera el puerto y se marca fallido", async () => {
  const pm = new PortManager();
  const { journal: j } = await journal();
  const links: FakeByteLink[] = [];
  const worker = new DeviceWorker(
    {
      id: "b1",
      name: "Balanza colgada",
      resource: serialResource("COM3"),
      createLink: () => {
        const l = new FakeByteLink();
        links.push(l);
        return l;
      },
    },
    fastOptions(pm, { journal: j, watchdogMs: 60 }),
  );
  worker.start();
  let sawAbort = false;
  const outcome = await worker.enqueue({
    id: "colgado",
    kind: "cuelgue",
    // Un trabajo que nunca avanza y además ignora la señal.
    run: (ctx) =>
      new Promise(() => {
        ctx.signal.addEventListener("abort", () => (sawAbort = true));
      }),
  });
  assert.equal(outcome.status, "failed");
  assert.equal(codeOf(outcome), "watchdog");
  assert.equal(sawAbort, true);
  assert.equal(links[0].isOpen, false, "se cerró el enlace viejo");
  assert.equal(j.get("colgado")?.status, "failed");
  // Reconecta solo y vuelve a atender trabajos.
  await waitFor(() => worker.status().state === "ready" && links.length === 2);
  const next = await worker.enqueue({ kind: "después", run: async () => "ok" });
  assert.equal(next.status, "done");
  await worker.stop();
});

test("el vigía no corta un trabajo largo que va avisando avance", async () => {
  const pm = new PortManager();
  const worker = new DeviceWorker({ id: "b1", name: "B1", resource: serialResource("COM3"), createLink: () => new FakeByteLink() }, fastOptions(pm, { watchdogMs: 50 }));
  worker.start();
  const outcome = await worker.enqueue({
    kind: "largo",
    run: async (ctx) => {
      for (let i = 0; i < 6; i += 1) {
        await sleep(25);
        ctx.heartbeat();
      }
      return "terminó";
    },
  });
  assert.equal(outcome.status, "done");
  await worker.stop();
});

test("desconexión a mitad: el trabajo queda interrumpido (no fallido) y reconecta con espera creciente", async () => {
  const pm = new PortManager();
  const { journal: j } = await journal();
  const links: FakeByteLink[] = [];
  const worker = new DeviceWorker(
    {
      id: "b1",
      name: "Balanza",
      resource: serialResource("COM3"),
      createLink: () => {
        const l = new FakeByteLink({ respond: (w) => (text(w) === "1" ? "ok1" : null) });
        // Al reconectar, las dos primeras veces el adaptador todavía no volvió.
        if (links.length >= 1) l.openErrorFor = () => (links.length <= 3 ? new Error("Opening COM3: File not found") : null);
        links.push(l);
        return l;
      },
    },
    fastOptions(pm, { journal: j, watchdogMs: 2000, commandTimeoutMs: 1000 }),
  );
  worker.start();
  const outcome = await worker.enqueue({
    id: "mitad",
    kind: "envío",
    run: async (ctx) => {
      await ctx.command(enc("1"));
      await ctx.confirmStep("producto-1");
      setTimeout(() => links[0].simulateDisconnect(), 10);
      await ctx.command(enc("2")); // nunca contesta: se corta antes
      await ctx.confirmStep("producto-2");
    },
  });
  assert.equal(outcome.status, "interrupted");
  assert.equal(codeOf(outcome), "disconnected");
  const record = j.get("mitad");
  assert.equal(record?.status, "interrupted");
  assert.equal(record?.resumable, true);
  assert.deepEqual(record?.steps.map((s) => s.key), ["producto-1"], "solo lo confirmado");

  await waitFor(() => worker.status().state === "ready", 3000);
  assert.equal(links.length, 4, "1 conexión + 2 intentos fallidos + 1 bueno");
  assert.equal(worker.status().reconnectAttempt, 0);
  assert.equal(pm.ownerOf(serialResource("COM3")), "Balanza (b1)");
  await worker.stop();
});

test("arranque con la balanza desenchufada: reintenta y el trabajo espera o falla claro", async () => {
  const pm = new PortManager();
  let attempts = 0;
  const worker = new DeviceWorker(
    {
      id: "b1",
      name: "Balanza",
      resource: serialResource("COM9"),
      createLink: () => {
        const l = new FakeByteLink();
        attempts += 1;
        l.nextOpenError = new Error("Opening COM9: File not found");
        return l;
      },
    },
    fastOptions(pm, { waitReadyMs: 60 }),
  );
  worker.start();
  const outcome = await worker.enqueue({ kind: "x", run: async () => "no debería correr" });
  assert.equal(outcome.status, "failed");
  assert.equal(codeOf(outcome), "not_connected");
  assert.match(messageOf(outcome), /no existe/);
  assert.ok(attempts >= 2);
  assert.equal(worker.status().lastError?.code, "not_found");
  await worker.stop();
  assert.equal(worker.status().state, "stopped");
});

test("puerto tomado por otro programa: queda informado como tal", async () => {
  const pm = new PortManager();
  const worker = new DeviceWorker(
    {
      id: "b1",
      name: "Balanza",
      resource: serialResource("COM4"),
      createLink: () => {
        const l = new FakeByteLink();
        l.nextOpenError = new Error("Opening COM4: Access denied");
        return l;
      },
    },
    fastOptions(pm),
  );
  worker.start();
  await waitFor(() => worker.status().lastError !== null);
  assert.equal(worker.status().lastError?.code, "busy_other_program");
  await worker.stop();
});

test("dos dispositivos a la vez: uno colgado no frena al otro", async () => {
  const pm = new PortManager();
  const { journal: j } = await journal();
  const registry = new DeviceRegistry(fastOptions(pm, { journal: j, watchdogMs: 120 }));
  const hung = new FakeByteLink({ label: "COM3" });
  hung.hung = true;
  const healthy = new FakeByteLink({ label: "192.168.0.50:1001", respond: (w) => `R${text(w)}`, replyDelayMs: 5 });
  registry.add({ id: "colgada", name: "Colgada", resource: serialResource("COM3"), createLink: () => hung });
  registry.add({ id: "sana", name: "Sana", resource: tcpResource("192.168.0.50", 1001), createLink: () => healthy });
  registry.startAll();
  await waitFor(() => registry.statuses().every((s) => s.state === "ready"));

  const hungJob = registry.get("colgada")!.enqueue({
    kind: "cuelgue",
    run: async (ctx) => {
      ctx.heartbeat();
      return new Promise(() => undefined);
    },
  });
  const started = Date.now();
  const healthyResults = [];
  for (let i = 0; i < 5; i += 1) {
    healthyResults.push(
      await registry.get("sana")!.enqueue({ kind: "precio", run: async (ctx) => text(await ctx.command(enc(String(i)))) }),
    );
  }
  const healthyMs = Date.now() - started;
  assert.deepEqual(healthyResults.map((r) => (r.status === "done" ? r.result : r.status)), ["R0", "R1", "R2", "R3", "R4"]);
  assert.ok(healthyMs < 120, `la sana terminó antes de que salte el vigía de la otra (${healthyMs} ms)`);

  const hungOutcome = await hungJob;
  assert.equal(codeOf(hungOutcome), "watchdog");
  assert.equal(registry.get("sana")!.status().state, "ready");
  assert.equal(registry.get("sana")!.status().jobsFailed, 0);
  await registry.stopAll();
  assert.equal(pm.list().length, 0);
});

test("una excepción del trabajo no tumba al trabajador", async () => {
  const pm = new PortManager();
  const worker = new DeviceWorker({ id: "b1", name: "B1", resource: serialResource("COM3"), createLink: () => new FakeByteLink() }, fastOptions(pm));
  worker.start();
  const bad = await worker.enqueue({
    kind: "roto",
    run: async () => {
      throw new TypeError("bug del protocolo");
    },
  });
  assert.equal(codeOf(bad), "job_error");
  const good = await worker.enqueue({ kind: "sano", run: async () => 1 });
  assert.equal(good.status, "done");
  await worker.stop();
});

test("si el diario no puede anotar un paso, el trabajo no sigue", async () => {
  const pm = new PortManager();
  const { journal: j, storage } = await journal();
  const worker = new DeviceWorker({ id: "b1", name: "B1", resource: serialResource("COM3"), createLink: () => new FakeByteLink() }, fastOptions(pm, { journal: j }));
  worker.start();
  let afterStep = false;
  const outcome = await worker.enqueue({
    id: "sin-disco",
    kind: "x",
    run: async (ctx) => {
      storage.failNextSave = new Error("disco lleno");
      await ctx.confirmStep("paso");
      afterStep = true;
    },
  });
  assert.equal(outcome.status, "failed");
  assert.equal(afterStep, false);
  assert.deepEqual(j.get("sin-disco")?.steps, []);
  await worker.stop();
});

test("apagar con un trabajo en curso lo deja interrumpido y descarta la cola", async () => {
  const pm = new PortManager();
  const { journal: j } = await journal();
  const worker = new DeviceWorker({ id: "b1", name: "B1", resource: serialResource("COM3"), createLink: () => new FakeByteLink() }, fastOptions(pm, { journal: j, watchdogMs: 5000 }));
  worker.start();
  const running = worker.enqueue({ id: "largo", kind: "x", run: () => new Promise(() => undefined) });
  const queued = worker.enqueue({ id: "en-cola", kind: "x", run: async () => 1 });
  await waitFor(() => worker.status().currentJob !== null);
  await worker.stop();
  const [r, q] = await Promise.all([running, queued]);
  assert.equal(r.status, "interrupted");
  assert.equal(q.status, "interrupted");
  assert.equal(j.get("largo")?.status, "interrupted");
  assert.equal(pm.list().length, 0);
  const late = await worker.enqueue({ kind: "x", run: async () => 1 });
  assert.equal(late.status, "failed");
});
