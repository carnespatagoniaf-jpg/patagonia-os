// Prueba de punta a punta del servicio, sin hardware: configuración con dos
// balanzas simuladas, puertos de mentira, diario en disco y /status por HTTP.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startService } from "./service";
import { resolvePaths } from "./config/paths";
import { FakeByteLink } from "./link/fake-byte-link";
import { StaticPortLister } from "./discovery/port-lister";
import { JsonFileJournalStorage, StoredJobJournal } from "./journal/job-journal";

function getStatus(port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/status", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      })
      .on("error", reject);
  });
}

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("no se cumplió a tiempo");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("servicio completo: arranca, informa estado, recupera interrumpidos y apaga prolijo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scale-connect-svc-"));
  const paths = resolvePaths({ dev: false, env: { PATAGONIA_CONNECT_HOME: root }, cwd: root });

  // Un trabajo quedó "en curso" de una corrida anterior (se cortó la luz).
  const before = new StoredJobJournal(new JsonFileJournalStorage(paths.journalFile));
  await before.open();
  await before.begin({ id: "viejo", deviceId: "mostrador", kind: "envío" });
  await before.confirmStep("viejo", "plu-1");

  await mkdir(root, { recursive: true });
  await writeFile(
    paths.configFile,
    JSON.stringify({
      backoffMs: [100],
      discoveryIntervalMs: 0,
      devices: [
        { id: "mostrador", name: "Aura mostrador", transport: { type: "serial", path: "COM3", baudRate: 9600 } },
        { id: "report", name: "Report depósito", transport: { type: "tcp", host: "192.168.0.50", port: 1001 } },
        { id: "mala", transport: { type: "tcp", host: "8.8.8.8", port: 1001 } },
      ],
    }),
  );

  const links = new Map<string, FakeByteLink>();
  const service = await startService({
    paths,
    dev: false,
    httpPort: 0,
    portLister: new StaticPortLister([
      { path: "COM3", vendorId: "1a86", productId: "7523", serialNumber: "5&1&0&3", locationId: "Port_#0003.Hub_#0001" },
    ]),
    createLink: (device) => {
      const link = new FakeByteLink({ label: device.id, respond: () => "OK" });
      if (device.id === "report") link.nextOpenError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      links.set(device.id, link);
      return link;
    },
  });

  try {
    await waitFor(() => service.registry.get("mostrador")!.status().state === "ready");
    await waitFor(() => service.registry.get("report")!.status().lastError !== null);
    const status = await getStatus(service.port);
    assert.equal(status.ok, true);
    assert.equal(status.service, "patagonia-scale-connect");
    assert.equal(typeof status.version, "string");
    assert.deepEqual(status.devices.map((d: { id: string }) => d.id), ["mostrador", "report"]);
    assert.equal(status.devices[0].state, "ready");
    assert.equal(status.devices[1].lastError.code, "refused");
    assert.equal(status.ports.ports[0].chipLabel, "CH340");
    assert.equal(status.jobs.interrupted, 1);
    assert.equal(status.problems.length, 1, "la balanza con IP pública se informa, no se usa");

    // El interrumpido NO se reenvió: la balanza no recibió nada.
    assert.equal(links.get("mostrador")!.writes.length, 0);
    assert.equal(service.journal.get("viejo")?.status, "interrupted");

    const outcome = await service.registry.get("mostrador")!.enqueue({ kind: "prueba", run: async (ctx) => ctx.command(Buffer.from("W")) });
    assert.equal(outcome.status, "done");
  } finally {
    await service.stop();
  }
  assert.equal(service.portManager.list().length, 0);
  const log = await readFile(path.join(paths.logsDir, "connector.log"), "utf8");
  assert.match(log, /Trabajo interrumpido por un reinicio/);
  assert.match(log, /Apagado completo/);
});
