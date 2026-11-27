// Registro de trabajadores: uno por balanza. Si armar o arrancar uno falla,
// queda anotado y los demás siguen.

import { DeviceWorker, type DeviceSpec, type DeviceWorkerOptions, type WorkerStatus } from "./device-worker";
import { silentLogger, type Logger } from "../log/logger";

export interface RegistryProblem {
  deviceId: string;
  message: string;
}

export class DeviceRegistry {
  private readonly workers = new Map<string, DeviceWorker>();
  readonly problems: RegistryProblem[] = [];
  private readonly log: Logger;

  constructor(private readonly options: DeviceWorkerOptions) {
    this.log = options.logger ?? silentLogger;
  }

  add(spec: DeviceSpec): DeviceWorker | null {
    if (this.workers.has(spec.id)) {
      this.problems.push({ deviceId: spec.id, message: `Hay dos balanzas con el id "${spec.id}".` });
      return null;
    }
    try {
      const worker = new DeviceWorker(spec, this.options);
      this.workers.set(spec.id, worker);
      return worker;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.problems.push({ deviceId: spec.id, message });
      this.log.error("No se pudo preparar la balanza", { device: spec.id, error });
      return null;
    }
  }

  get(id: string): DeviceWorker | undefined {
    return this.workers.get(id);
  }

  startAll(): void {
    for (const worker of this.workers.values()) {
      try {
        worker.start();
      } catch (error) {
        this.problems.push({ deviceId: worker.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.workers.values()].map((w) => w.stop()));
  }

  statuses(): WorkerStatus[] {
    return [...this.workers.values()].map((w) => w.status());
  }
}
