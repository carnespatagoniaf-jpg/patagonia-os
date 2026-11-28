// Prueba de punta a punta de Scale Connect, sin hardware ni base:
//
//   web (lógica de Mis balanzas, connect/scale-connect-jobs.ts)  →  nube simulada (226/227)  →  servicio completo
//   (startService: agente, ejecutor, balanzas de la PC)  →  dos balanzas simuladas: una Kretz Report por TCP y una
//   Systel Cuora por un puerto serie FTDI simulado (los simuladores de las pruebas de protocolos).
//
// 1. Vincular la PC, y "Agregar balanza → En esta computadora": la PC identifica sus balanzas SOLO LEYENDO y las
//    informa con su huella física; la web las registra y las vincula a ese puerto.
// 2. Dos envíos a la vez, uno a cada balanza: los dos terminan con el resultado de cada producto, en paralelo.
// 3. Se corta la Report a mitad de un envío: la Cuora igual termina.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startService } from "../service";
import { resolvePaths } from "../config/paths";
import { StaticPortLister } from "../discovery/port-lister";
import { TcpByteLink } from "../link/tcp-byte-link";
import { MemoryCredentialStore } from "../cloud/credential-store";
import { FakeCloud, type FakeScaleProfile } from "../cloud/test-fake-cloud";
import { createMemoryLogger } from "../log/logger";
import { FakeCuora, FakeReportDevice, cuoraLink, startReportServer } from "../protocols/testing/simulators";
import { catalog, waitFor } from "../protocols/testing/harness";
import { fakeReadRecord } from "../../../web/src/features/inventory/systel/systel-fake";
import {
  foundScales,
  IDENTIFY_SCALE_KEY,
  parseConnectStatus,
  parseJobItems,
  parseJobRow,
  runConnectorJob,
  sendPayload,
  sendResultView,
  type ConnectDevice,
  type ScaleConnectPort,
} from "../../../web/src/features/scales/connect/scale-connect-jobs";

const REPORT_IP = "192.168.50.10";

/** La base, como la ve la web (scale_connect_status, queue_scale_job, scale_jobs, bind_scale_to_connector) sobre la nube simulada. */
function webPort(cloud: FakeCloud): ScaleConnectPort {
  return {
    async status() {
      const connectors = [...cloud.connectors.values()].filter((c) => !c.revoked);
      const online = (id: string) => {
        const c = cloud.connectors.get(id);
        return !!c?.lastSeen && Date.now() - c.lastSeen < 120_000;
      };
      return parseConnectStatus({
        connectors: connectors.map((c) => ({ id: c.id, name: c.name, online: online(c.id) })),
        bindings: cloud.scales
          .filter((s) => s.connectorId)
          .map((s) => ({ scale_key: s.key, connector_id: s.connectorId, connector_name: cloud.connectors.get(s.connectorId!)?.name, online: online(s.connectorId!), device: s.device })),
      });
    },
    async queue(input) {
      return cloud.queueJob({ scaleKey: input.scaleKey, kind: input.kind, payload: input.payload, connectorId: input.connectorId }).id;
    },
    async job(id) {
      const j = cloud.jobs.find((x) => x.id === id);
      if (!j) return null;
      const count = (st: string) => j.items.filter((i) => i.status === st).length;
      const job = parseJobRow({
        id: j.id,
        status: j.status,
        progress: j.progress.at(-1) ?? null,
        error_code: j.error,
        confirmed_count: count("confirmed"),
        failed_count: count("failed"),
        skipped_count: count("skipped"),
      })!;
      return { job, items: j.status === "queued" || j.status === "running" ? [] : parseJobItems(j.items) };
    },
    async bind(_branchId, scaleKey, connectorId, device) {
      const s = cloud.scales.find((x) => x.key === scaleKey)!;
      s.connectorId = connectorId;
      s.device = device as Record<string, unknown> | null;
    },
  };
}

function cuoraDevice(): FakeCuora {
  const f = new FakeCuora("max60", { address: 1, protocol: "0060" });
  f.plus.set(900, fakeReadRecord("max60", { number: 900, name: "MODELO KILO", price: 100, code: 900, type: "P" }));
  return f;
}

test("Scale Connect de punta a punta: agregar, dos envíos en paralelo y una que se desconecta", { timeout: 120_000 }, async () => {
  const cloud = new FakeCloud();
  await cloud.start();
  cloud.claimWaitMs = 20;
  cloud.addCode("ABCDEFGH");

  const report = new FakeReportDevice();
  const reportServer = await startReportServer(report);
  const cuora = cuoraDevice();
  const cuoraCable = cuoraLink(cuora, "COM7");

  const root = await mkdtemp(path.join(os.tmpdir(), "scale-connect-e2e-"));
  const paths = resolvePaths({ dev: false, env: { PATAGONIA_CONNECT_HOME: root }, cwd: root });
  await writeFile(
    paths.configFile,
    JSON.stringify({ backoffMs: [100, 200], discoveryIntervalMs: 0, cloud: { url: cloud.baseUrl, heartbeatMs: 10_000, pollWaitSec: 1 } }),
  );
  const logger = createMemoryLogger();
  const service = await startService({
    paths,
    dev: false,
    httpPort: 0,
    logger,
    // La PC tiene un adaptador FTDI en COM7 (la Cuora). La Report va por red.
    portLister: new StaticPortLister([{ path: "COM7", vendorId: "0403", productId: "6001", serialNumber: "FT7QX2AB", manufacturer: "FTDI" }]),
    createLink: (device) => {
      const t = device.transport;
      if (t.type === "serial" && t.path === "COM7") return cuoraCable;
      if (t.type === "tcp" && t.host === REPORT_IP) return new TcpByteLink({ host: "127.0.0.1", port: reportServer.port });
      throw new Error(`puerto inesperado: ${JSON.stringify(t)}`);
    },
    cloud: { store: new MemoryCredentialStore(), fingerprint: async () => "f".repeat(64), backoffMs: [20, 40, 80], minPollGapMs: 10 },
  });
  const port = webPort(cloud);
  const watch = { pollMs: 40, queuedCheckMs: 60_000 };

  try {
    // ── 1. Vincular y "Agregar balanza → En esta computadora con Scale Connect" ────────────────────────────────
    const paired = await service.cloud.agent.pair({ code: "ABCD-EFGH", name: "Caja 1" });
    assert.equal(paired.kind, "paired");
    await waitFor(() => [...cloud.connectors.values()].some((c) => c.lastSeen !== null), 5000);
    const status = await port.status("b1");
    assert.deepEqual(status?.connectors.map((c) => [c.name, c.online]), [["Caja 1", true]]);
    const pc = status!.connectors[0];

    const search = await runConnectorJob(
      port,
      { branchId: "b1", scaleKey: IDENTIFY_SCALE_KEY, kind: "read", payload: { mode: "identify", network: [{ host: REPORT_IP, port: 1001 }] }, connector: pc },
      watch,
    );
    assert.equal(search.kind, "terminado");
    if (search.kind !== "terminado") return;
    const found = foundScales(search.items);
    const systel = found.find((f) => f.family === "systel");
    const kretz = found.find((f) => f.family === "kretz");
    assert.ok(systel && kretz, JSON.stringify(found));
    // Huella física: el adaptador por su serie real (no el COM), la Report por IP:puerto.
    assert.equal(systel.device.kind, "serial");
    assert.equal(systel.device.path, "COM7");
    assert.match(systel.device.fingerprint ?? "", /sn:FT7QX2AB/);
    assert.deepEqual([kretz.device.kind, kretz.device.host, kretz.device.port], ["tcp", REPORT_IP, 1001]);
    assert.deepEqual(kretz.identity, { letter: "C", equipment: "01" });
    // Solo lectura: nada escrito en ninguna balanza.
    assert.deepEqual(report.writes, []);
    assert.equal(cuora.received.filter((x) => x.fn === 61 || x.fn === 33).length, 0);
    // El latido ya las informa (sin vincular todavía: "dev:<id>").
    await waitFor(() => (cloud.connectors.get(pc.id)?.scales ?? []).filter((s) => s.device).length === 2, 5000);
    assert.ok(cloud.connectors.get(pc.id)!.scales.every((s) => s.key.startsWith("dev:")));

    // La web registra cada una (register_branch_scale) y la vincula a su puerto (bind_scale_to_connector).
    const register = (key: string, f: typeof systel): FakeScaleProfile => {
      const row: FakeScaleProfile = { key, name: f.label, family: f.family, model: f.label, identity: f.identity, active: true, connectorId: null, device: null };
      cloud.scales.push(row);
      return row;
    };
    register("systel-1", systel);
    register("kretz-1", kretz);
    await port.bind("b1", "systel-1", pc.id, systel.device as ConnectDevice);
    await port.bind("b1", "kretz-1", pc.id, kretz.device as ConnectDevice);
    const bound = await port.status("b1");
    assert.deepEqual(bound!.bindings.map((b) => [b.scaleKey, b.online]).sort(), [["kretz-1", true], ["systel-1", true]]);

    // ── 2. Dos envíos a la vez, uno a cada balanza ───────────────────────────────────────────────────────────
    const reportProducts = catalog(20, 1, 26);
    const cuoraProducts = catalog(20, 1, 18);
    const send = (scaleKey: string, products: typeof reportProducts) =>
      runConnectorJob(port, { branchId: "b1", scaleKey, kind: "send", payload: sendPayload(products, { canManageLinks: true }), connector: bound!.bindings.find((b) => b.scaleKey === scaleKey)! }, watch);
    const [r1, c1] = await Promise.all([send("kretz-1", reportProducts), send("systel-1", cuoraProducts)]);
    assert.equal(r1.kind, "terminado");
    assert.equal(c1.kind, "terminado");
    if (r1.kind !== "terminado" || c1.kind !== "terminado") return;
    for (const [run, products] of [[r1, reportProducts], [c1, cuoraProducts]] as const) {
      assert.equal(run.items.length, 20, "resultado de CADA producto");
      assert.ok(run.items.every((i) => i.status === "confirmed" && i.action === "write"), JSON.stringify(run.job));
      const view = sendResultView(run.job, run.items, [...products]);
      assert.equal(view.headline, "20 de 20 productos quedaron y se comprobaron en la balanza.");
      assert.ok((run.job.progress?.total ?? 0) === 20, "avance informado");
    }
    // En paralelo: cada uno empezó antes de que terminara el otro.
    const jr = cloud.jobs.find((j) => j.id === r1.job.id)!;
    const jc = cloud.jobs.find((j) => j.id === c1.job.id)!;
    assert.ok(jr.claimedAt! < jc.finishedAt! && jc.claimedAt! < jr.finishedAt!, "los dos envíos corrieron a la vez");
    // Lo que quedó de verdad en cada balanza simulada.
    for (const p of reportProducts) assert.ok(report.records.has(Number(p.code)), `PLU ${p.code} en la Report`);
    for (const p of cuoraProducts) assert.ok(cuora.plus.has(Number(p.code)), `PLU ${p.code} en la Cuora`);
    // El motor habló con Patagonia por la nube, en el trabajo y la balanza de cada uno.
    // Kretz: la sucursal tiene DOS balanzas, así que el formato de etiqueta no se cambia solo (resguardo C1, igual que
    // en la web): los productos quedan, el envío queda "con aviso" y el detalle va a soporte.
    assert.equal(jc.status, "done");
    assert.equal(jr.status, "partial");
    assert.equal(jr.error, "con_aviso");
    assert.match(r1.job.progress?.text ?? "", /más de una balanza: el formato de etiqueta no se cambió/);
    assert.ok(cloud.engineCalls.some((c) => c.action === "list_branch_scales" && c.jobId === jr.id), "Kretz leyó las balanzas de la sucursal");
    assert.equal(cloud.branchConfig, null);
    assert.ok(cloud.reports.some((r) => String(r.note).includes("send")), "reporte a soporte por la nube");
    assert.equal((cloud.catalogs.get("systel-1")?.items as unknown[]).length >= 20, true, "Systel: catálogo para Mostrador");
    assert.equal(cloud.links.get("systel-1")?.length, 20, "Systel: vínculos de los 20 productos");
    assert.ok(cloud.engineCalls.filter((c) => c.action === "set_scale_links").every((c) => c.jobId === jc.id));
    // Ya vinculadas: el latido las informa con su scale_key.
    service.cloud.agent.heartbeatNow();
    await waitFor(() => (cloud.connectors.get(pc.id)?.scales ?? []).map((s) => s.key).sort().join() === "kretz-1,systel-1", 5000);

    // ── 3. Se corta la Report a mitad: la Cuora igual termina ─────────────────────────────────────────────────
    const reportPrices = reportProducts.map((p) => ({ ...p, priceRetail: p.priceRetail + 11 }));
    const cuoraPrices = cuoraProducts.map((p) => ({ ...p, priceRetail: p.priceRetail + 7 }));
    let writes = 0;
    report.onWrite = () => {
      writes += 1;
      // Al tercer producto se cae la red de la Report (y no vuelve).
      if (writes === 3) void reportServer.close();
    };
    const [r2, c2] = await Promise.all([send("kretz-1", reportPrices), send("systel-1", cuoraPrices)]);
    assert.equal(c2.kind, "terminado");
    assert.equal(r2.kind, "terminado");
    if (r2.kind !== "terminado" || c2.kind !== "terminado") return;
    assert.equal(c2.job.status, "done");
    assert.equal(c2.items.filter((i) => i.status === "confirmed").length, 20);
    assert.equal(sendResultView(c2.job, c2.items, cuoraPrices).headline, "20 de 20 productos quedaron y se comprobaron en la balanza.");
    assert.notEqual(r2.job.status, "done");
    assert.equal(r2.items.length, 20, "también con la balanza cortada: el resultado de cada producto");
    assert.ok(r2.items.some((i) => i.status === "failed" && (i.reason ?? "").length > 0));
    const view = sendResultView(r2.job, r2.items, reportPrices);
    assert.equal(view.ok, false);
    assert.match(view.headline, /^\d+ de 20 productos quedaron y se comprobaron en la balanza\.$/);
  } finally {
    await service.stop();
    await reportServer.close().catch(() => undefined);
    await cloud.stop();
  }
});
