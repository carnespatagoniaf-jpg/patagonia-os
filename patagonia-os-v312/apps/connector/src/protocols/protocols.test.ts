// Protocolos de la WEB corriendo en el conector (sin copiarlos), contra balanzas
// simuladas: Report por TCP (servidor local), Aura y Cuora por puerto serie simulado.

import test from "node:test";
import assert from "node:assert/strict";
import { serialResource, tcpResource } from "../ports/port-manager";
import { TcpByteLink } from "../link/tcp-byte-link";
import { FakeByteLink } from "../link/fake-byte-link";
import { MemoryJournalStorage } from "../journal/job-journal";
import type { JobOutcome } from "../worker/device-worker";
import { fakeReadRecord } from "../../../web/src/features/inventory/systel/systel-fake";
import { REAL_CLIENT_RECORDS } from "../../../web/src/features/inventory/kretz/aura-fake-device";
import { parseAuraPlu } from "../../../web/src/features/inventory/kretz/aura-plu";
import { FakeCuora, FakeReportDevice, RealAuraDevice, auraLink, cuoraLink, startReportServer, CH340, FTDI } from "./testing/simulators";
import { catalog, testScale, waitFor, type Product, type TestScale } from "./testing/harness";
import type { SendResult } from "./scale-jobs";

const REPORT_WIDTHS = [6, 3, 3, 26, 26, 5, 1, 7, 6, 6, 6, 6, 6, 5, 5, 2, 4, 4, 4, 4];
function reportFields(record: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (const w of REPORT_WIDTHS) {
    out.push(record.slice(i, i + w));
    i += w;
  }
  return out;
}

function cuoraDevice(): FakeCuora {
  const f = new FakeCuora("max60", { address: 1, protocol: "0060" });
  // La balanza ya tiene productos del cliente en 900 y 901: nunca se tocan.
  f.plus.set(900, fakeReadRecord("max60", { number: 900, name: "MODELO KILO", price: 100, code: 900, type: "P" }));
  f.plus.set(901, fakeReadRecord("max60", { number: 901, name: "MODELO UNIDAD", price: 50, code: 901, type: "U" }));
  return f;
}

const SYSTEL_WRITE_FUNCTIONS = new Set([4, 7, 10, 25, 33, 35, 61]);

async function reportScale(report: FakeReportDevice, extra: Parameters<typeof testScale>[0]["worker"] = {}) {
  const server = await startReportServer(report);
  const scale = await testScale({
    device: { id: "report", name: "Report depósito", transport: { type: "tcp", host: "127.0.0.1", port: server.port } },
    resource: tcpResource("127.0.0.1", server.port),
    createLink: () => new TcpByteLink({ host: "127.0.0.1", port: server.port }),
    worker: extra,
  });
  return { ...scale, server };
}

async function auraScale(link: FakeByteLink, storage?: MemoryJournalStorage) {
  return testScale({
    device: { id: "aura", name: "Aura mostrador", transport: { type: "serial", ...CH340 } },
    resource: serialResource("COM5"),
    createLink: () => link,
    storage,
  });
}

async function cuoraScale(link: FakeByteLink) {
  return testScale({
    device: { id: "cuora", name: "Cuora caja", transport: { type: "serial", ...FTDI } },
    resource: serialResource("COM7"),
    createLink: () => link,
  });
}

function done<T>(o: JobOutcome<T>): T {
  assert.equal(o.status, "done", JSON.stringify(o).slice(0, 1500));
  return (o as { result: T }).result;
}

function errorOf(o: JobOutcome<unknown>): { code: string; message: string } {
  return o.status === "done" ? { code: "", message: "" } : o.error;
}

function assertAllConfirmed(r: SendResult, count: number) {
  const bad = r.products.filter((p) => p.status !== "confirmado");
  assert.equal(bad.length, 0, `${r.model}: ${r.message} ${JSON.stringify(bad).slice(0, 800)}`);
  assert.equal(r.confirmed, count);
  assert.equal(r.ok, true, r.message);
}

const steps = (s: TestScale, jobId: string) => (s.journal.get(jobId)?.steps ?? []).map((x) => x.key);

test("1. identificar cada balanza, SOLO LEYENDO", async () => {
  const report = new FakeReportDevice();
  const aura = new RealAuraDevice();
  const cuora = cuoraDevice();
  const r = await reportScale(report);
  const a = await auraScale(auraLink(aura));
  const c = await cuoraScale(cuoraLink(cuora));
  try {
    const [ro, ao, co] = await Promise.all([r.host.identify(), a.host.identify(), c.host.identify()]);
    const ri = done(ro);
    const ai = done(ao);
    const ci = done(co);
    assert.deepEqual([ri.found, ri.family, ri.model], [true, "kretz", "kretz-report-lt"]);
    assert.equal(ri.support.red, true, "la Report por TCP se trata como balanza por red (NetScalePort)");
    assert.deepEqual(ri.identity, { letter: "C", equipment: "01" });
    assert.deepEqual([ai.found, ai.family, ai.model], [true, "kretz", "kretz-aura"]);
    assert.deepEqual([ci.found, ci.family], [true, "systel"]);
    assert.deepEqual(ci.identity, { address: 1 });
    // Solo lectura: ni un alta, ni un cambio de precio, ni configuración.
    assert.deepEqual(report.writes, []);
    assert.deepEqual(aura.writes, []);
    assert.deepEqual(cuora.received.filter((x) => SYSTEL_WRITE_FUNCTIONS.has(x.fn)), []);
    // Cada balanza tiene su propia instancia del código de la web.
    assert.equal(r.host.instanceCount + a.host.instanceCount + c.host.instanceCount, 3);

    // Prueba de conexión: con la marca recordada, contesta.
    const t = done(await a.host.test());
    assert.equal(t.ok, true);
    assert.equal(t.model, "kretz-aura");
  } finally {
    await Promise.all([r.worker.stop(), a.worker.stop(), c.worker.stop()]);
    await r.server.close();
  }
});

test("2. mandar 20 productos a cada una y comprobar la relectura", async () => {
  const report = new FakeReportDevice();
  const aura = new RealAuraDevice();
  const cuora = cuoraDevice();
  const r = await reportScale(report);
  const a = await auraScale(auraLink(aura));
  const c = await cuoraScale(cuoraLink(cuora));
  const reportProducts = catalog(20, 1, 26);
  const auraProducts = catalog(20, 101);
  const cuoraProducts = catalog(20, 1, 18);
  try {
    const [ro, ao, co] = await Promise.all([
      r.host.send({ branchId: "b1", products: reportProducts }, "envio-report"),
      a.host.send({ branchId: "b1", products: auraProducts }, "envio-aura"),
      c.host.send({ branchId: "b1", products: cuoraProducts }, "envio-cuora"),
    ]);
    const rr = done(ro);
    const ar = done(ao);
    const cr = done(co);
    assertAllConfirmed(rr, 20);
    assertAllConfirmed(ar, 20);
    assertAllConfirmed(cr, 20);
    assert.deepEqual([rr.model, ar.model, cr.model], ["kretz-report-lt", "kretz-aura", "systel-cuora-max"]);

    // Lo que quedó en cada balanza simulada, mirado aparte del motor.
    for (const p of reportProducts) {
      const f = reportFields(report.records.get(Number(p.code))!);
      assert.equal(f[3].trimEnd(), p.name);
      assert.equal(f[6], p.unit === "kg" ? "P" : "N");
      assert.equal(Number(f[8]), p.priceRetail);
    }
    for (const p of auraProducts) {
      const rec = aura.records.find((x) => Number(x.slice(0, 6)) === Number(p.code));
      const parsed = rec ? parseAuraPlu(rec) : null;
      assert.ok(parsed, `PLU ${p.code} en la Aura`);
      assert.equal(parsed!.name.trim(), p.name.toUpperCase());
      assert.equal(parsed!.type, p.unit === "kg" ? "D" : "C");
      assert.equal(Number(parsed!.priceRaw), p.priceRetail);
    }
    for (const original of REAL_CLIENT_RECORDS) assert.ok(aura.records.includes(original), "los productos del cliente quedan intactos");
    for (const p of cuoraProducts) assert.ok(cuora.plus.has(Number(p.code)), `PLU ${p.code} en la Cuora`);
    assert.equal(cuora.plus.get(900), fakeReadRecord("max60", { number: 900, name: "MODELO KILO", price: 100, code: 900, type: "P" }));

    // El diario anotó cada producto confirmado.
    assert.equal(steps(r, "envio-report").filter((k) => k.startsWith("producto:")).length, 20);
    assert.equal(steps(a, "envio-aura").filter((k) => k.startsWith("producto:")).length, 20);
    assert.equal(steps(c, "envio-cuora").filter((k) => k.startsWith("producto:")).length, 20);
    // Systel: Mostrador quedó sabiendo qué producto es cada número (backend en memoria).
    assert.equal(c.backend.links.get("b1|cuora")?.length, 20);
    // Kretz: el formato de etiqueta de la sucursal se guardó por el backend.
    assert.ok(r.backend.branchConfigs.get("b1"));

    // Segundo envío: relee y no escribe nada (ya está todo igual).
    const before = { report: report.writes.length, aura: aura.writes.length, cuora: cuora.received.filter((x) => x.fn === 61).length };
    const again = await Promise.all([
      r.host.send({ branchId: "b1", products: reportProducts }),
      a.host.send({ branchId: "b1", products: auraProducts }),
      c.host.send({ branchId: "b1", products: cuoraProducts }),
    ]);
    for (const o of again) assertAllConfirmed(done(o), 20);
    assert.equal(report.writes.length, before.report);
    assert.equal(aura.writes.length, before.aura);
    assert.equal(cuora.received.filter((x) => x.fn === 61).length, before.cuora);
  } finally {
    await Promise.all([r.worker.stop(), a.worker.stop(), c.worker.stop()]);
    await r.server.close();
  }
});

test("3. desconexión a mitad → interrumpido; reinicio → interrumpido; reanudar relee y no pisa", async () => {
  const aura = new RealAuraDevice();
  const link = auraLink(aura);
  const products: Product[] = catalog(20, 101);
  const a = await auraScale(link);
  let snapshot: MemoryJournalStorage["records"] | null = null;
  let count = 0;
  aura.onWrite = () => {
    count += 1;
    if (count === 8) {
      // Lo que había en disco cuando "se cortó la luz": el trabajo en curso.
      snapshot = structuredClone(a.storage.records);
      setTimeout(() => link.simulateDisconnect("cable desenchufado"), 0);
    }
  };
  let b: TestScale | null = null;
  try {
    const first = await a.host.send({ branchId: "b1", products }, "envio-cortado");
    assert.equal(first.status, "interrupted", JSON.stringify(first));
    assert.equal(errorOf(first).code, "disconnected");
    const record = a.journal.get("envio-cortado");
    assert.equal(record?.status, "interrupted");
    assert.equal(record?.resumable, true);
    const firstWrites = new Set(aura.writes);
    assert.ok(firstWrites.size >= 8 && firstWrites.size < 20, `se cortó a mitad (${firstWrites.size} escritos)`);
    aura.onWrite = null;

    // Reinicio del servicio: el diario en disco tenía el trabajo "en curso".
    await a.worker.stop();
    assert.ok(snapshot, "hubo un corte a mitad");
    const storage = new MemoryJournalStorage();
    storage.records = snapshot!;
    b = await auraScale(link, storage);
    const recovered = b.journal.get("envio-cortado");
    assert.equal(recovered?.status, "interrupted");
    assert.equal(recovered?.error?.code, "restart");

    const writesBefore = aura.writes.length;
    const second = done(await b.host.send({ branchId: "b1", products }, "envio-reanudado"));
    assertAllConfirmed(second, 20);
    assert.deepEqual(second.resumedFrom, ["envio-cortado"]);
    const secondWrites = aura.writes.slice(writesBefore);
    assert.deepEqual(secondWrites.filter((plu) => firstWrites.has(plu)), [], "lo que ya estaba grabado no se vuelve a escribir");
    assert.equal(new Set([...firstWrites, ...secondWrites]).size, 20);
    for (const original of REAL_CLIENT_RECORDS) assert.ok(aura.records.includes(original));
  } finally {
    await a.worker.stop();
    await b?.worker.stop();
  }
});

test("4. tres balanzas a la vez en trabajadores distintos: una se cuelga y las otras terminan", async () => {
  const report = new FakeReportDevice();
  const aura = new RealAuraDevice();
  const cuora = cuoraDevice();
  const r = await reportScale(report, { watchdogMs: 1500 });
  const a = await auraScale(auraLink(aura));
  const c = await cuoraScale(cuoraLink(cuora));
  // La Report se cuelga en la primera alta: recibe y nunca más contesta.
  report.onWrite = () => {
    report.hung = true;
  };
  try {
    const [ro, ao, co] = await Promise.all([
      r.host.send({ branchId: "b1", products: catalog(20, 1, 26) }),
      a.host.send({ branchId: "b1", products: catalog(20, 101) }),
      c.host.send({ branchId: "b1", products: catalog(20, 1, 18) }),
    ]);
    assert.equal(ro.status, "failed");
    assert.equal(errorOf(ro).code, "watchdog");
    assertAllConfirmed(done(ao), 20);
    assertAllConfirmed(done(co), 20);
    assert.equal(r.worker.status().jobsFailed, 1);

    // La Report vuelve a contestar: el trabajador reconectó solo y el envío sale entero.
    report.hung = false;
    report.onWrite = null;
    await waitFor(() => r.worker.status().state === "ready", 5000);
    assertAllConfirmed(done(await r.host.send({ branchId: "b1", products: catalog(20, 1, 26) })), 20);
  } finally {
    await Promise.all([r.worker.stop(), a.worker.stop(), c.worker.stop()]);
    await r.server.close();
  }
});

test("5. puerto tomado por otro programa → error claro", async () => {
  // a) Windows niega el puerto desde el principio (iTegra/Qendra lo tienen abierto).
  const taken = new FakeByteLink({ label: "COM9", lineSettings: { baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" }, usbInfo: CH340 });
  taken.openErrorFor = () => new Error("Opening COM9: Access denied");
  const t = await testScale({
    device: { id: "tomada", name: "Aura tomada", transport: { type: "serial", ...CH340 } },
    resource: serialResource("COM9"),
    createLink: () => taken,
    worker: { waitReadyMs: 300 },
  });
  // b) Abre, pero al reabrirlo en otra velocidad (búsqueda Kretz) otro programa lo agarra.
  const aura = new RealAuraDevice();
  const grabbed = auraLink(aura, "COM6");
  grabbed.currentSettings = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none" };
  grabbed.openErrorFor = (attempt) => (attempt >= 2 ? new Error("Opening COM6: Access denied") : null);
  const g = await testScale({
    device: { id: "agarrada", name: "Aura", transport: { type: "serial", ...CH340 } },
    resource: serialResource("COM6"),
    createLink: () => grabbed,
  });
  try {
    const sent = await t.host.send({ branchId: "b1", products: catalog(3, 101) });
    assert.equal(sent.status, "failed");
    assert.equal(errorOf(sent).code, "not_connected");
    assert.match(errorOf(sent).message, /lo tiene abierto otro programa/);
    assert.equal(t.worker.status().lastError?.code, "busy_other_program");

    const found = await g.host.identify();
    assert.equal(found.status, "failed", JSON.stringify(found));
    assert.equal(errorOf(found).code, "busy_other_program");
    assert.match(errorOf(found).message, /lo tiene abierto otro programa/);
    assert.deepEqual(aura.writes, []);
  } finally {
    await Promise.all([t.worker.stop(), g.worker.stop()]);
  }
});
