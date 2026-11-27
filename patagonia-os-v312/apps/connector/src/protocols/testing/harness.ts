// Arma un "conector de prueba" con una balanza: gestor de puertos, diario,
// trabajador y anfitrión de protocolos, como lo arma el servicio.

import type { ByteLink } from "../../link/byte-link";
import { PortManager, type ResourceKey } from "../../ports/port-manager";
import { MemoryJournalStorage, StoredJobJournal } from "../../journal/job-journal";
import { DeviceWorker, type DeviceWorkerOptions } from "../../worker/device-worker";
import { MemoryEngineBackend } from "../engine-backend";
import { ScaleProtocolHost, type ProtocolDevice } from "../scale-jobs";

export interface TestScale {
  worker: DeviceWorker;
  host: ScaleProtocolHost;
  journal: StoredJobJournal;
  storage: MemoryJournalStorage;
  backend: MemoryEngineBackend;
  portManager: PortManager;
}

export async function testScale(options: {
  device: ProtocolDevice;
  resource: ResourceKey;
  createLink: () => ByteLink;
  portManager?: PortManager;
  storage?: MemoryJournalStorage;
  backend?: MemoryEngineBackend;
  worker?: Partial<DeviceWorkerOptions>;
}): Promise<TestScale> {
  const portManager = options.portManager ?? new PortManager();
  const storage = options.storage ?? new MemoryJournalStorage();
  const journal = new StoredJobJournal(storage);
  await journal.open();
  const backend = options.backend ?? new MemoryEngineBackend();
  const worker = new DeviceWorker(
    { id: options.device.id, name: options.device.name, resource: options.resource, createLink: options.createLink },
    { portManager, journal, backoffMs: [30, 60, 120], watchdogMs: 20_000, commandTimeoutMs: 2000, waitReadyMs: 3000, ...options.worker },
  );
  worker.start();
  const host = new ScaleProtocolHost({ device: options.device, worker, backend, journal, stateFile: null });
  return { worker, host, journal, storage, backend, portManager };
}

export type Product = { id: string; code: string; name: string; unit: string; priceRetail: number };

/** Productos de carnicería, kilo y unidad, con acentos. */
export function catalog(count: number, firstCode = 1, nameLength = 16): Product[] {
  const names = ["Vacio", "Matambre", "Tapa asado", "Roast beef", "Peceto", "Nalga", "Bola lomo", "Cuadrada", "Chorizo", "Milanesa"];
  return Array.from({ length: count }, (_, i) => ({
    id: `p${firstCode + i}`,
    code: String(firstCode + i),
    name: `${names[i % names.length]} ${firstCode + i}`.slice(0, nameLength),
    unit: i % 4 === 3 ? "unit" : "kg",
    priceRetail: 1000 + i * 137,
  }));
}

export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("no se cumplió a tiempo");
    await new Promise((r) => setTimeout(r, 5));
  }
}
