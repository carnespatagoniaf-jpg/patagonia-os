// Arma el servicio completo: configuración, bitácora, diario, gestor de
// puertos, trabajadores, descubridor y canal local. Separado de main.ts para
// poder probarlo entero sin hardware.

import os from "node:os";
import { loadConfig, type ConnectorConfig, type DeviceConfig } from "./config/config";
import type { ConnectorPaths } from "./config/paths";
import { JsonFileJournalStorage, StoredJobJournal, type JobJournal } from "./journal/job-journal";
import { createLogger, type Logger } from "./log/logger";
import type { ByteLink } from "./link/byte-link";
import { SerialByteLink } from "./link/serial-byte-link";
import { TcpByteLink } from "./link/tcp-byte-link";
import { PortManager } from "./ports/port-manager";
import { DeviceRegistry } from "./worker/device-registry";
import { SerialportLister, discoverPorts, type DiscoveryResult, type PortLister } from "./discovery/port-lister";
import { createLocalServer, type LocalServer } from "./server/local-server";
import { CONNECTOR_VERSION, SERVICE_NAME } from "./version";
import { MemoryEngineBackend, type EngineBackend } from "./protocols/engine-backend";
import type { ScaleProtocolHost } from "./protocols/scale-jobs";
import { createCloudModule, type CloudModule, type CloudModuleOverrides } from "./cloud/cloud-module";
import { ScaleFleet } from "./scales/scale-fleet";
import { ScaleJobExecutor } from "./scales/scale-executor";

export interface ServiceOptions {
  paths: ConnectorPaths;
  dev: boolean;
  /** Para pruebas: otro listador de puertos. */
  portLister?: PortLister;
  /** Para pruebas: crear enlaces falsos en vez de reales. */
  createLink?: (device: DeviceConfig) => ByteLink;
  /** Para pruebas: puerto HTTP (0 = cualquiera libre). */
  httpPort?: number;
  /** Lo que el motor de balanzas le pide a Patagonia FUERA de un trabajo de la nube (banco). En los trabajos de la nube va por la nube. */
  backend?: EngineBackend;
  /** Para pruebas: otro empaquetado del código de protocolos de la web. */
  loadProtocolSource?: () => Promise<string>;
  logger?: Logger;
  /** Para pruebas: nube simulada (fetch, credencial en memoria, ejecutor falso). */
  cloud?: CloudModuleOverrides;
  env?: Record<string, string | undefined>;
}

export interface RunningService {
  config: ConnectorConfig;
  logger: Logger;
  journal: JobJournal;
  registry: DeviceRegistry;
  portManager: PortManager;
  /** Trabajos de protocolos (identify / test / send) de cada balanza, por id (las de config.json y las identificadas). */
  scales: Map<string, ScaleProtocolHost>;
  /** Las balanzas de esta PC y a qué scale_key de Patagonia corresponde cada una. */
  fleet: ScaleFleet;
  server: LocalServer;
  cloud: CloudModule;
  port: number;
  status(): Record<string, unknown>;
  stop(): Promise<void>;
}

export function linkFor(device: DeviceConfig): ByteLink {
  const t = device.transport;
  return t.type === "serial"
    ? new SerialByteLink({ path: t.path, baudRate: t.baudRate, dataBits: t.dataBits, stopBits: t.stopBits, parity: t.parity })
    : new TcpByteLink({ host: t.host, port: t.port });
}

export async function startService(options: ServiceOptions): Promise<RunningService> {
  const { paths } = options;
  const loaded = await loadConfig(paths.configFile);
  const config = loaded.config;

  const logger =
    options.logger ??
    createLogger({
      dir: paths.logsDir,
      level: config.log.level,
      maxBytes: config.log.maxBytes,
      maxFiles: config.log.maxFiles,
      console: options.dev,
    });
  const startedAt = new Date();
  logger.info("Arranca Patagonia Scale Connect", { version: CONNECTOR_VERSION, dev: options.dev, root: paths.root, node: process.version });
  if (loaded.createdDefault) logger.info("Se creó la configuración de fábrica", { file: paths.configFile });
  for (const error of loaded.errors) logger.warn("Problema en la configuración", { error });

  const journal = new StoredJobJournal(new JsonFileJournalStorage(paths.journalFile));
  const recovery = await journal.open();
  if (recovery.corruptMovedTo) logger.error("El diario de trabajos estaba dañado y se apartó", { movedTo: recovery.corruptMovedTo });
  for (const job of recovery.interrupted) {
    logger.warn("Trabajo interrumpido por un reinicio: queda para reanudar, no se reenvía", {
      jobId: job.id,
      device: job.deviceId,
      kind: job.kind,
      steps: job.steps.length,
    });
  }

  const portManager = new PortManager();
  const registry = new DeviceRegistry({
    portManager,
    journal,
    logger,
    backoffMs: config.backoffMs,
    watchdogMs: config.watchdogMs,
    commandTimeoutMs: config.commandTimeoutMs,
  });
  const makeLink = options.createLink ?? linkFor;

  const lister = options.portLister ?? new SerialportLister();
  let discovery: DiscoveryResult = { ok: false, ports: [], error: "Todavía no se listaron los puertos.", at: startedAt.toISOString() };
  const refreshPorts = async () => {
    const result = await discoverPorts(lister);
    if (!result.ok && discovery.ok !== result.ok) logger.warn("No se pudieron listar los puertos", { error: result.error });
    discovery = result;
  };
  await refreshPorts();
  logger.info("Puertos encontrados", { count: discovery.ports.length, ports: discovery.ports.map((p) => `${p.path} ${p.chipLabel}`) });
  // Las balanzas de esta PC (config.json + las identificadas antes), cada una con su trabajador y sus protocolos
  // Kretz/Systel de la web (src/protocols). Una vista "por id" para quien la quiera (scales).
  const backend = options.backend ?? new MemoryEngineBackend();
  let notifyChange: () => void = () => undefined;
  const fleet = new ScaleFleet({
    registry,
    journal,
    logger,
    backend,
    root: paths.root,
    createLink: makeLink,
    listPorts: async () => {
      await refreshPorts();
      return discovery.ports;
    },
    loadSource: options.loadProtocolSource,
    onChange: () => notifyChange(),
  });
  await fleet.start(config.devices);
  const scales = new Map<string, ScaleProtocolHost>();
  const syncScales = () => {
    scales.clear();
    for (const d of fleet.list()) scales.set(d.id, d.host);
  };
  syncScales();
  const discoveryTimer =
    config.discoveryIntervalMs > 0 ? setInterval(() => void refreshPorts(), config.discoveryIntervalMs) : null;
  discoveryTimer?.unref();

  const status = () => ({
    service: SERVICE_NAME,
    version: CONNECTOR_VERSION,
    computer: os.hostname(),
    startedAt: startedAt.toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
    devices: registry.statuses(),
    ports: discovery,
    jobs: {
      running: journal.list({ status: "running" }).length,
      interrupted: journal.list({ status: "interrupted" }).length,
    },
    problems: [...loaded.errors, ...registry.problems.map((p) => `${p.deviceId}: ${p.message}`)],
    cloud: cloud.status(),
  });

  // Nube (vinculación, latido y trabajos). Cada balanza se informa con su huella física y con el scale_key que le
  // dio la web (o "dev:<id>" si todavía no la vinculó). Los trabajos los corre el ejecutor sobre los protocolos.
  const executor = options.cloud?.executor ?? new ScaleJobExecutor({ fleet, logger, afterIdentify: () => notifyChange() });
  const cloud = createCloudModule({
    settings: config.cloud,
    credentialFile: paths.credentialFile,
    env: options.env ?? process.env,
    version: CONNECTOR_VERSION,
    logger,
    seenScales: () => fleet.seenScales(),
    overrides: { ...options.cloud, executor },
    onConfig: (cfg) => fleet.applyConfig(cfg),
  });
  notifyChange = () => {
    syncScales();
    cloud.agent.heartbeatNow();
  };

  const server = createLocalServer({ port: options.httpPort ?? config.http.port, getStatus: status, logger, routes: cloud.routes });
  let address;
  try {
    address = await server.listen();
  } catch (error) {
    logger.error("No se pudo abrir el canal local (¿otro programa usa el puerto?)", { port: config.http.port, error });
    await registry.stopAll();
    await portManager.releaseAll();
    await journal.close();
    throw error;
  }
  logger.info("Canal local escuchando", { address: `${address.address}:${address.port}` });
  await cloud.start();

  let stopped = false;
  return {
    config,
    logger,
    journal,
    registry,
    portManager,
    scales,
    fleet,
    server,
    cloud,
    port: address.port,
    status,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      logger.info("Se apaga Patagonia Scale Connect");
      if (discoveryTimer) clearInterval(discoveryTimer);
      await cloud.stop();
      await server.close();
      await registry.stopAll();
      await portManager.releaseAll();
      await journal.close();
      logger.info("Apagado completo");
    },
  };
}
