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
import { PortManager, serialResource, tcpResource } from "./ports/port-manager";
import { DeviceRegistry } from "./worker/device-registry";
import { SerialportLister, discoverPorts, type DiscoveryResult, type PortLister } from "./discovery/port-lister";
import { createLocalServer, type LocalServer } from "./server/local-server";
import { CONNECTOR_VERSION, SERVICE_NAME } from "./version";
import { createCloudModule, type CloudModule, type CloudModuleOverrides } from "./cloud/cloud-module";

export interface ServiceOptions {
  paths: ConnectorPaths;
  dev: boolean;
  /** Para pruebas: otro listador de puertos. */
  portLister?: PortLister;
  /** Para pruebas: crear enlaces falsos en vez de reales. */
  createLink?: (device: DeviceConfig) => ByteLink;
  /** Para pruebas: puerto HTTP (0 = cualquiera libre). */
  httpPort?: number;
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
  for (const device of config.devices) {
    const t = device.transport;
    registry.add({
      id: device.id,
      name: device.name,
      resource: t.type === "serial" ? serialResource(t.path) : tcpResource(t.host, t.port),
      createLink: () => makeLink(device),
    });
  }
  registry.startAll();

  const lister = options.portLister ?? new SerialportLister();
  let discovery: DiscoveryResult = { ok: false, ports: [], error: "Todavía no se listaron los puertos.", at: startedAt.toISOString() };
  const refreshPorts = async () => {
    const result = await discoverPorts(lister);
    if (!result.ok && discovery.ok !== result.ok) logger.warn("No se pudieron listar los puertos", { error: result.error });
    discovery = result;
  };
  await refreshPorts();
  logger.info("Puertos encontrados", { count: discovery.ports.length, ports: discovery.ports.map((p) => `${p.path} ${p.chipLabel}`) });
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

  // Nube (vinculación, latido y trabajos): la balanza es "vista" con el id de config.json (= scale_key de la base).
  const cloud = createCloudModule({
    settings: config.cloud,
    credentialFile: paths.credentialFile,
    env: options.env ?? process.env,
    version: CONNECTOR_VERSION,
    logger,
    seenScales: () => registry.statuses().map((s) => ({ key: s.id, name: s.name, online: s.state === "ready" || s.state === "busy" })),
    overrides: options.cloud,
  });

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
