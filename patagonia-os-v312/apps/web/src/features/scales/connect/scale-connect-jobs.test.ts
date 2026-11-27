import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectorFor,
  identifyNetwork,
  foundScales,
  offlineMessage,
  parseConnectStatus,
  parseJobItems,
  parseJobRow,
  runConnectorJob,
  sendPayload,
  sendResultView,
  whereText,
  type ConnectJob,
  type ConnectJobItem,
  type ConnectStatus,
  type ScaleConnectPort
} from "./scale-connect-jobs";

const PID = "3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b";
const products = [
  { id: PID, code: "1", name: "Nalga", unit: "kg", priceRetail: 18000 },
  { id: "demo-2", code: "2", name: "Vacío", unit: "kg", priceRetail: 15000, active: false },
  { id: "demo-3", code: "3", name: "Chorizo", unit: "unit", priceRetail: 900 }
];

const STATUS: ConnectStatus = parseConnectStatus({
  connectors: [{ id: "c1", name: "Caja 1", online: true, last_seen_at: "2026-11-27T10:00:00Z" }, { id: "c2", name: "Fondo", online: false }],
  bindings: [
    { scale_key: "kretz-1", connector_id: "c1", connector_name: "Caja 1", online: true, device: { id: "usb-1", kind: "serial", path: "COM3" } },
    { scale_key: "systel-1", connector_id: "c2", connector_name: "Fondo", online: false, device: null },
    { scale_key: "", connector_id: "c1" }
  ]
});

describe("Scale Connect en Mis balanzas: estado", () => {
  it("lee el estado y descarta lo raro", () => {
    assert.equal(STATUS.connectors.length, 2);
    assert.equal(STATUS.bindings.length, 2);
    assert.deepEqual(STATUS.bindings[0].device, { id: "usb-1", kind: "serial", path: "COM3" });
  });

  it("la balanza va por Scale Connect solo si está vinculada a una PC", () => {
    assert.equal(connectorFor(STATUS, "kretz-1")?.connectorName, "Caja 1");
    assert.equal(connectorFor(STATUS, "otra"), null, "sin Scale Connect: por cable como siempre");
    assert.equal(connectorFor(null, "kretz-1"), null, "sin la migración 227: por cable");
  });

  it("PC apagada: mensaje simple con su nombre", () => {
    assert.match(offlineMessage("Caja 1"), /^La computadora Caja 1 está apagada o sin internet/);
  });
});

describe("Scale Connect en Mis balanzas: envío", () => {
  it("el payload lleva los mismos productos que el envío por cable, y product_id solo si es real", () => {
    const p = sendPayload(products, { canManageLinks: true, weightBarcode: true });
    const list = p.products as Array<Record<string, unknown>>;
    assert.deepEqual(list[0], { product_id: PID, plu: "1", name: "Nalga", unit: "kg", price: 18000, active: true });
    assert.equal("product_id" in list[1], false);
    assert.equal(list[1].active, false);
    assert.equal(p.weight_barcode, true);
    assert.equal(p.allow_replace, false);
  });

  it("encola, consulta cada 2 s y termina con el resultado por producto", async () => {
    const polls: ConnectJob["status"][] = ["queued", "running", "running", "partial"];
    const slept: number[] = [];
    const queued: unknown[] = [];
    const port: ScaleConnectPort = {
      status: async () => STATUS,
      queue: async (input) => {
        queued.push(input);
        return "job-1";
      },
      job: async () => {
        const status = polls.shift()!;
        const job = parseJobRow({ id: "job-1", status, progress: { done: 1, total: 3, text: "1 de 3 comprobados" }, error_code: status === "partial" ? "productos_fallados" : null })!;
        const items: ConnectJobItem[] =
          status === "partial"
            ? parseJobItems([
                { product_id: PID, plu: "1", action: "write", status: "confirmed" },
                { plu: "2", action: "write", status: "failed", reason: "al releerlo, el número está vacío en la balanza" },
                { plu: "3", action: "write", status: "skipped", reason: "sin precio" }
              ])
            : [];
        return { job, items };
      },
      bind: async () => undefined
    };
    const seen: string[] = [];
    const run = await runConnectorJob(
      port,
      { branchId: "b1", scaleKey: "kretz-1", kind: "send", payload: sendPayload(products), connector: STATUS.bindings[0] },
      { sleep: async (ms) => void slept.push(ms), onProgress: (j) => seen.push(j.status) }
    );
    assert.equal(run.kind, "terminado");
    assert.deepEqual(slept, [2000, 2000, 2000, 2000]);
    assert.deepEqual(seen, ["queued", "running", "running", "partial"]);
    assert.equal((queued[0] as { connectorId: string }).connectorId, "c1");
    if (run.kind !== "terminado") return;
    const view = sendResultView(run.job, run.items, products);
    assert.equal(view.headline, "1 de 3 productos quedaron y se comprobaron en la balanza.");
    assert.equal(view.ok, false);
    assert.equal(view.confirmed, 1);
    assert.deepEqual(view.failures, [{ code: "2", name: "Vacío", reason: "al releerlo, el número está vacío en la balanza" }]);
    assert.deepEqual(view.skipped, [{ code: "3", name: "Chorizo", reason: "sin precio" }]);
  });

  it("si la PC no toma el envío y dejó de latir: 'está apagada o sin internet'", async () => {
    let t = 0;
    const port: ScaleConnectPort = {
      status: async () => ({ ...STATUS, connectors: STATUS.connectors.map((c) => ({ ...c, online: false })) }),
      queue: async () => "job-2",
      job: async () => ({ job: parseJobRow({ id: "job-2", status: "queued" })!, items: [] }),
      bind: async () => undefined
    };
    const run = await runConnectorJob(
      port,
      { branchId: "b1", scaleKey: "kretz-1", kind: "send", payload: {}, connector: STATUS.bindings[0] },
      { sleep: async (ms) => void (t += ms), now: () => t }
    );
    assert.deepEqual(run, { kind: "apagada", message: offlineMessage("Caja 1"), jobId: "job-2" });
    assert.ok(t >= 30_000);
  });

  it("todo bien: el mismo texto que por cable", () => {
    const job = parseJobRow({ id: "j", status: "done", progress: { done: 2, total: 2, text: "Listo" } })!;
    const items = parseJobItems([{ plu: "1", status: "confirmed" }, { plu: "3", status: "confirmed" }]);
    const view = sendResultView(job, items, products);
    assert.equal(view.ok, true);
    assert.equal(view.headline, "2 de 2 productos quedaron y se comprobaron en la balanza.");
    assert.match(view.next[0], /Ya podés vender/);
  });
});

describe("Scale Connect en Mis balanzas: agregar", () => {
  it("las balanzas que encontró la PC, con su huella física", () => {
    const found = foundScales(
      parseJobItems([
        {
          action: "read",
          status: "confirmed",
          sent: { id: "usb-1", kind: "serial", path: "COM7", fingerprint: "usb:0403:6001:sn:A1" },
          read_back: { device_id: "usb-1", name: "Systel Cuora Max (COM7)", family: "systel", model: "systel-cuora-max", label: "Systel Cuora Max", identity: { address: 1 } }
        },
        { action: "read", status: "confirmed", sent: { id: "net-1", kind: "tcp", host: "192.168.0.50", port: 1001 }, read_back: { family: "kretz", label: "Kretz Report LT", identity: { letter: "C" } } },
        { action: "read", status: "confirmed", sent: { kind: "serial" }, read_back: { family: "kretz" } },
        { action: "read", status: "confirmed", sent: { id: "x" }, read_back: { family: "otra" } }
      ])
    );
    assert.equal(found.length, 2);
    assert.deepEqual(found[0].identity, { address: 1 });
    assert.equal(found[0].family, "systel");
    assert.equal(whereText(found[0].device), "en COM7");
    assert.equal(whereText(found[1].device), "por red 192.168.0.50");
  });
});

describe("identifyNetwork: direcciones de red que busca Scale Connect", () => {
  it("toma lo escrito con comas o espacios, suma las conocidas, sin repetir, en los dos puertos", () => {
    assert.deepEqual(identifyNetwork(["192,168,1,50"], ["192.168.1.50", "169.254.137.200"]), [
      { host: "192.168.1.50", port: 1001 },
      { host: "192.168.1.50", port: 10001 },
      { host: "169.254.137.200", port: 1001 },
      { host: "169.254.137.200", port: 10001 }
    ]);
  });
  it("descarta lo que no es una IP de red local", () => {
    assert.deepEqual(identifyNetwork(["8.8.8.8", "300.1.1.1", "hola", ""]), []);
  });
});
