// Las balanzas de ESTA PC: cuáles hay, en qué puerto, y qué scale_key de Patagonia es cada una.
//
// - Cada balanza es un "dispositivo" con su trabajador (cola propia, vigía) y su anfitrión de protocolos
//   (ScaleProtocolHost). Vienen de config.json (banco de pruebas) o de identificarlas (trabajo "identify" de la nube):
//   se prueban los puertos de la PC SOLO LEYENDO y las que contestan quedan guardadas en scales.json.
// - Huella física de cada una: serie real del adaptador USB o su ubicación (discovery/port-classify), el COM, o la
//   IP:puerto. El id local sale de esa huella: si Windows le cambia el número de COM, sigue siendo la misma.
// - La web vincula cada balanza registrada a ESTE puerto (migración 227, bind_scale_to_connector); la configuración de
//   la nube trae ese vínculo y acá se arma scale_key → dispositivo.
// - En el latido se informan todas: con su scale_key si ya está vinculada, o "dev:<id>" si todavía no.

import { createHash } from "node:crypto";
import path from "node:path";
import type { DeviceConfig } from "../config/config";
import { isLocalNetworkIPv4 } from "../config/config";
import type { DiscoveredPort } from "../discovery/port-classify";
import type { JobJournal } from "../journal/job-journal";
import type { ByteLink } from "../link/byte-link";
import { silentLogger, type Logger } from "../log/logger";
import { serialResource, tcpResource } from "../ports/port-manager";
import { readJsonFile, writeFileAtomic } from "../storage/atomic-file";
import type { DeviceRegistry } from "../worker/device-registry";
import type { EngineBackend } from "../protocols/engine-backend";
import { ScaleProtocolHost, protocolDeviceFor, type IdentifyResult, type ScaleFamily } from "../protocols/scale-jobs";
import type { CloudConfig, ScaleDevice, SeenScale } from "../cloud/cloud-client";

export interface IdentifiedScale {
  family: ScaleFamily;
  model: string | null;
  label: string | null;
  identity: Record<string, unknown>;
  at: string;
}

export interface FleetDevice {
  id: string;
  name: string;
  source: "config" | "detected";
  transport: DeviceConfig["transport"];
  physical: ScaleDevice;
  identified: IdentifiedScale | null;
  host: ScaleProtocolHost;
}

/** Lo que encontró un "identify" en un puerto. */
export interface IdentifyFinding {
  deviceId: string;
  name: string;
  physical: ScaleDevice;
  found: boolean;
  /** Ya estaba en la lista de balanzas de esta PC (antes de identificar). */
  known: boolean;
  result: IdentifyResult | null;
  error: { code: string; message: string } | null;
}

export interface ScaleFleetOptions {
  registry: DeviceRegistry;
  journal?: JobJournal;
  logger?: Logger;
  /** Backend del motor fuera de los trabajos de la nube (banco, pruebas). */
  backend: EngineBackend;
  /** Carpeta de datos (scales.json, protocols/<id>.json). null = solo memoria (pruebas). */
  root: string | null;
  createLink: (device: DeviceConfig) => ByteLink;
  /** Vuelve a listar los puertos de la PC. */
  listPorts: () => Promise<DiscoveredPort[]>;
  /** Para pruebas: otro empaquetado del código de la web. */
  loadSource?: () => Promise<string>;
  watchdogMs?: Partial<Record<"identify" | "test" | "send", number>>;
  /** Se llama cuando cambia la lista (para latir enseguida). */
  onChange?: () => void;
}

interface StoredDevice {
  id: string;
  name: string;
  transport: DeviceConfig["transport"];
  physical: ScaleDevice;
  identified: IdentifiedScale | null;
}

interface StoredFile {
  version: 1;
  devices: StoredDevice[];
  /** scale_key → id del dispositivo (la última configuración de la nube). */
  bindings: Record<string, string>;
}

const shortHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** Id local de un puerto serie a partir de su huella (estable aunque cambie el COM). */
export function serialDeviceId(port: Pick<DiscoveredPort, "fingerprint">): string {
  return `usb-${shortHash(port.fingerprint)}`;
}

export function tcpDeviceId(host: string, port: number): string {
  return `net-${host.replace(/[^0-9a-z]/gi, "-")}-${port}`;
}

/** Puertos que vale la pena probar: USB-serie, Bluetooth saliente y COM de la placa. Nunca los virtuales ni el Bluetooth "entrante". */
export function probeablePort(p: DiscoveredPort): boolean {
  if (p.kind === "virtual") return false;
  if (p.kind === "bluetooth" && p.bluetoothDirection === "incoming") return false;
  return true;
}

export function physicalOfSerial(port: DiscoveredPort | undefined, path: string, id: string): ScaleDevice {
  return {
    id,
    kind: "serial",
    path,
    ...(port ? { fingerprint: port.fingerprint, source: port.fingerprintSource, chip: port.chipLabel } : {}),
  };
}

export class ScaleFleet {
  private readonly devices = new Map<string, FleetDevice>();
  private bindings = new Map<string, string>();
  /** Lo último que dijo la nube de cada balanza de la sucursal (marca, nombre). */
  private cloudScales = new Map<string, { name: string | null; family: string | null; model: string | null }>();
  private readonly log: Logger;
  private ports: DiscoveredPort[] = [];
  private identifying: Promise<IdentifyFinding[]> | null = null;

  constructor(private readonly options: ScaleFleetOptions) {
    this.log = (options.logger ?? silentLogger).child({ part: "balanzas" });
  }

  private get file(): string | null {
    return this.options.root ? path.join(this.options.root, "scales.json") : null;
  }

  /** Arranca con las de config.json y las que se identificaron antes (scales.json). */
  async start(configured: DeviceConfig[]): Promise<void> {
    this.ports = await this.options.listPorts().catch(() => []);
    for (const d of configured) this.add(d, "config", null);
    const file = this.file;
    if (!file) return;
    const read = await readJsonFile<StoredFile>(file).catch(() => ({ status: "missing" as const }));
    if (read.status !== "ok" || !read.value || !Array.isArray(read.value.devices)) return;
    for (const s of read.value.devices) {
      if (!s || typeof s.id !== "string" || this.devices.has(s.id)) continue;
      const transport = this.currentTransport(s);
      if (!transport) continue;
      this.add({ id: s.id, name: s.name, transport }, "detected", s.identified ?? null, s.physical);
    }
    this.bindings = new Map(Object.entries(read.value.bindings ?? {}).filter(([, v]) => typeof v === "string"));
  }

  /** Un puerto serie detectado antes: el COM puede haber cambiado (se busca por la huella). */
  private currentTransport(s: StoredDevice): DeviceConfig["transport"] | null {
    if (s.transport?.type === "tcp") return isLocalNetworkIPv4(s.transport.host) ? s.transport : null;
    if (s.transport?.type !== "serial") return null;
    const now = s.physical.fingerprint ? this.ports.find((p) => p.fingerprint === s.physical.fingerprint) : undefined;
    return now ? { ...s.transport, path: now.path } : s.transport;
  }

  private add(device: DeviceConfig, source: FleetDevice["source"], identified: IdentifiedScale | null, physical?: ScaleDevice): FleetDevice | null {
    const t = device.transport;
    const worker = this.options.registry.add({
      id: device.id,
      name: device.name,
      resource: t.type === "serial" ? serialResource(t.path) : tcpResource(t.host, t.port),
      createLink: () => this.options.createLink(device),
    });
    if (!worker) return null;
    worker.start();
    const seen = t.type === "serial" ? this.ports.find((p) => p.path.toUpperCase() === t.path.toUpperCase()) : undefined;
    const phys: ScaleDevice =
      t.type === "tcp"
        ? { id: device.id, kind: "tcp", host: t.host, port: t.port, ...(physical?.mac ? { mac: physical.mac } : {}) }
        : { ...physicalOfSerial(seen, t.path, device.id), ...(physical?.fingerprint && !seen ? { fingerprint: physical.fingerprint, source: physical.source, chip: physical.chip } : {}) };
    const host = new ScaleProtocolHost({
      device: protocolDeviceFor(device, this.ports),
      worker,
      backend: this.options.backend,
      journal: this.options.journal,
      logger: this.options.logger,
      stateFile: this.options.root ? path.join(this.options.root, "protocols", `${device.id}.json`) : null,
      loadSource: this.options.loadSource,
      watchdogMs: this.options.watchdogMs,
    });
    const entry: FleetDevice = { id: device.id, name: device.name, source, transport: t, physical: phys, identified, host };
    this.devices.set(device.id, entry);
    return entry;
  }

  list(): FleetDevice[] {
    return [...this.devices.values()];
  }

  get(id: string): FleetDevice | undefined {
    return this.devices.get(id);
  }

  /** La balanza de Patagonia (scale_key) → el dispositivo de esta PC, según lo que vinculó la web. */
  resolve(scaleKey: string): FleetDevice | null {
    const id = this.bindings.get(scaleKey);
    return (id && this.devices.get(id)) || null;
  }

  /** Marca que la nube tiene para esa balanza ("kretz" | "systel"), si la sabe. */
  familyOf(scaleKey: string): ScaleFamily | null {
    const f = this.cloudScales.get(scaleKey)?.family;
    return f === "kretz" || f === "systel" ? f : null;
  }

  /** Aplica la configuración de la nube: qué balanza está en qué puerto de esta PC. */
  async applyConfig(config: CloudConfig): Promise<void> {
    const next = new Map<string, string>();
    this.cloudScales = new Map(config.scales.map((s) => [s.key, { name: s.name, family: s.family, model: s.model }]));
    for (const s of config.scales) {
      if (!s.key || !s.device) continue;
      if (this.devices.has(s.device.id)) next.set(s.key, s.device.id);
      else this.log.warn("La web vinculó una balanza a un puerto que esta PC no tiene", { scale: s.key, device: s.device.id });
    }
    const changed = JSON.stringify([...next].sort()) !== JSON.stringify([...this.bindings].sort());
    this.bindings = next;
    if (changed) {
      this.log.info("Balanzas vinculadas en esta PC", { bindings: Object.fromEntries(next) });
      await this.save();
      this.options.onChange?.();
    }
  }

  /** Lo que va en el latido. */
  seenScales(): SeenScale[] {
    const keyOf = new Map([...this.bindings].map(([key, id]) => [id, key]));
    const states = new Map(this.options.registry.statuses().map((s) => [s.id, s.state]));
    return this.list()
      .slice(0, 50)
      .map((d) => {
        const key = keyOf.get(d.id);
        const state = states.get(d.id);
        const cloudName = key ? this.cloudScales.get(key)?.name : null;
        return {
          key: key ?? `dev:${d.id}`,
          name: (cloudName || d.identified?.label || d.name).slice(0, 60),
          online: state === "ready" || state === "busy",
          device: d.physical,
          ...(d.identified ? { family: d.identified.family, model: d.identified.model ?? undefined, label: d.identified.label ?? undefined, identity: d.identified.identity } : {}),
        };
      });
  }

  /**
   * Prueba los puertos de la PC SOLO LEYENDO: las balanzas ya conocidas, los puertos nuevos (USB, Bluetooth, COM) y
   * las direcciones de red pedidas. Las que contestan quedan guardadas; los puertos sin balanza se sueltan.
   * Dos pedidos a la vez comparten la misma búsqueda.
   */
  identifyAll(input: { network?: Array<{ host: string; port: number }> } = {}, onProgress?: (done: number, total: number, text: string) => void): Promise<IdentifyFinding[]> {
    this.identifying ??= this.runIdentify(input, onProgress).finally(() => {
      this.identifying = null;
    });
    return this.identifying;
  }

  private async runIdentify(input: { network?: Array<{ host: string; port: number }> }, onProgress?: (done: number, total: number, text: string) => void): Promise<IdentifyFinding[]> {
    this.ports = await this.options.listPorts().catch(() => this.ports);
    const known = this.list();
    const knownPaths = new Set(known.flatMap((d) => (d.transport.type === "serial" ? [d.transport.path.toUpperCase()] : [])));
    const knownFingerprints = new Set(known.flatMap((d) => (d.physical.fingerprint ? [d.physical.fingerprint] : [])));
    const knownIds = new Set(known.map((d) => d.id));

    const fresh: FleetDevice[] = [];
    for (const p of this.ports) {
      if (!probeablePort(p) || knownPaths.has(p.path.toUpperCase()) || knownFingerprints.has(p.fingerprint)) continue;
      const id = serialDeviceId(p);
      if (knownIds.has(id) || this.devices.has(id)) continue;
      const added = this.add({ id, name: `${p.chipLabel} (${p.path})`, transport: { type: "serial", path: p.path, baudRate: 9600 } }, "detected", null);
      if (added) fresh.push(added);
    }
    for (const n of input.network ?? []) {
      if (!isLocalNetworkIPv4(n.host) || !Number.isInteger(n.port) || n.port < 1 || n.port > 65535) continue;
      const id = tcpDeviceId(n.host, n.port);
      if (this.devices.has(id)) continue;
      const added = this.add({ id, name: `Balanza por red ${n.host}`, transport: { type: "tcp", host: n.host, port: n.port } }, "detected", null);
      if (added) fresh.push(added);
    }

    const all = [...known, ...fresh];
    let done = 0;
    onProgress?.(0, all.length, `Buscando balanzas en ${all.length} ${all.length === 1 ? "puerto" : "puertos"}…`);
    const findings = await Promise.all(
      all.map(async (d): Promise<IdentifyFinding> => {
        const outcome = await d.host.identify(d.identified ? { family: d.identified.family } : {});
        done += 1;
        const result = outcome.status === "done" ? outcome.result : null;
        const finding: IdentifyFinding = {
          deviceId: d.id,
          name: d.name,
          physical: d.physical,
          found: !!result?.found,
          known: knownIds.has(d.id),
          result,
          error: outcome.status === "done" ? null : { code: outcome.error.code, message: outcome.error.message },
        };
        onProgress?.(done, all.length, finding.found ? `Encontrada: ${result?.label ?? d.name}` : `Sin balanza en ${d.name}`);
        return finding;
      }),
    );

    // Las que contestaron: quedan con su marca y modelo. Los puertos nuevos sin balanza se sueltan.
    for (const f of findings) {
      const d = this.devices.get(f.deviceId);
      if (!d) continue;
      if (f.found && f.result) {
        d.identified = { family: f.result.family!, model: f.result.model, label: f.result.label, identity: f.result.identity, at: new Date().toISOString() };
        if (d.source === "detected" && f.result.label) d.name = `${f.result.label} (${d.transport.type === "serial" ? d.transport.path : d.transport.host})`;
        f.name = d.name;
      } else if (!f.known) {
        this.devices.delete(d.id);
        await this.options.registry.remove(d.id);
      }
    }
    await this.save();
    this.options.onChange?.();
    this.log.info("Balanzas identificadas", { found: findings.filter((f) => f.found).map((f) => `${f.name}: ${f.result?.label}`), tried: findings.length });
    return findings;
  }

  private async save(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const data: StoredFile = {
      version: 1,
      devices: this.list()
        .filter((d) => d.source === "detected")
        .map((d) => ({ id: d.id, name: d.name, transport: d.transport, physical: d.physical, identified: d.identified })),
      bindings: Object.fromEntries(this.bindings),
    };
    try {
      await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    } catch (error) {
      this.log.warn("No se pudo guardar la lista de balanzas de esta PC", { error });
    }
  }
}
