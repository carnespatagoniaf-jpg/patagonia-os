// Configuración local (config.json). No guarda secretos: la credencial de la
// PC (vinculación, más adelante) va aparte y cifrada con DPAPI.
//
// Hoy la lista de balanzas sirve para probar en el banco; cuando exista la
// vinculación, la fuente de verdad será la nube y esto quedará como caché.

import { readJsonFile, writeFileAtomic } from "../storage/atomic-file";
import { DEFAULT_BACKOFF_MS } from "../worker/backoff";

export type SerialTransport = {
  type: "serial";
  path: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: "none" | "even" | "odd" | "mark" | "space";
};

export type TcpTransport = { type: "tcp"; host: string; port: number };

export interface DeviceConfig {
  id: string;
  name: string;
  transport: SerialTransport | TcpTransport;
}

export interface CloudSettings {
  /** Base de las Edge Functions (https://<proyecto>.supabase.co/functions/v1). null = sin nube. */
  url: string | null;
  heartbeatMs: number;
  pollWaitSec: number;
}

export interface ConnectorConfig {
  version: 1;
  http: { port: number };
  watchdogMs: number;
  commandTimeoutMs: number;
  backoffMs: number[];
  /** Cada cuánto se vuelven a listar los puertos (0 = solo al arrancar). */
  discoveryIntervalMs: number;
  log: { level: "debug" | "info" | "warn" | "error"; maxBytes: number; maxFiles: number };
  cloud: CloudSettings;
  devices: DeviceConfig[];
}

export const DEFAULT_CONFIG: ConnectorConfig = {
  version: 1,
  http: { port: 9120 },
  watchdogMs: 30_000,
  commandTimeoutMs: 2000,
  backoffMs: [...DEFAULT_BACKOFF_MS],
  discoveryIntervalMs: 60_000,
  log: { level: "info", maxBytes: 5 * 1024 * 1024, maxFiles: 5 },
  cloud: { url: null, heartbeatMs: 60_000, pollWaitSec: 25 },
  devices: [],
};

/** Solo https (o http a esta misma PC, para pruebas): el secreto de la PC nunca viaja sin cifrar. */
export function isValidCloudUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost"));
  } catch {
    return false;
  }
}

/** Solo direcciones de red local: no se habla con balanzas fuera de la LAN. */
export function isLocalNetworkIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim());
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const BAUDS = new Set([1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]);
const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function posInt(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

export interface ParsedConfig {
  config: ConnectorConfig;
  errors: string[];
}

/**
 * Valida la configuración. Lo inválido se informa y se reemplaza por el valor
 * por omisión (o se saltea la balanza), para que el servicio arranque igual y
 * muestre el problema en /status en lugar de caerse en un bucle de reinicios.
 */
export function parseConfig(raw: unknown): ParsedConfig {
  const errors: string[] = [];
  const config: ConnectorConfig = structuredClone(DEFAULT_CONFIG);
  if (!isObj(raw)) {
    errors.push("La configuración no es un objeto JSON: se usa la de fábrica.");
    return { config, errors };
  }

  if (raw.http !== undefined) {
    const port = isObj(raw.http) ? posInt(raw.http.port, 1024, 65535) : undefined;
    if (port === undefined) errors.push("http.port inválido (1024-65535): se usa 9120.");
    else config.http.port = port;
  }
  const watchdog = raw.watchdogMs === undefined ? config.watchdogMs : posInt(raw.watchdogMs, 1000, 600_000);
  if (watchdog === undefined) errors.push("watchdogMs inválido (1000-600000).");
  else config.watchdogMs = watchdog;

  const cmd = raw.commandTimeoutMs === undefined ? config.commandTimeoutMs : posInt(raw.commandTimeoutMs, 50, 120_000);
  if (cmd === undefined) errors.push("commandTimeoutMs inválido (50-120000).");
  else config.commandTimeoutMs = cmd;

  if (raw.backoffMs !== undefined) {
    const list = Array.isArray(raw.backoffMs) ? raw.backoffMs.map((v) => posInt(v, 100, 600_000)) : [];
    if (list.length === 0 || list.some((v) => v === undefined)) errors.push("backoffMs inválido (lista de 100-600000 ms).");
    else config.backoffMs = list as number[];
  }

  if (raw.discoveryIntervalMs !== undefined) {
    const v = raw.discoveryIntervalMs === 0 ? 0 : posInt(raw.discoveryIntervalMs, 5000, 3_600_000);
    if (v === undefined) errors.push("discoveryIntervalMs inválido (0 o 5000-3600000).");
    else config.discoveryIntervalMs = v;
  }

  if (raw.log !== undefined) {
    if (!isObj(raw.log)) errors.push("log inválido.");
    else {
      const level = raw.log.level;
      if (level !== undefined) {
        if (level === "debug" || level === "info" || level === "warn" || level === "error") config.log.level = level;
        else errors.push("log.level inválido (debug, info, warn, error).");
      }
      const maxBytes = raw.log.maxBytes === undefined ? config.log.maxBytes : posInt(raw.log.maxBytes, 64 * 1024, 100 * 1024 * 1024);
      if (maxBytes === undefined) errors.push("log.maxBytes inválido (64 KB a 100 MB).");
      else config.log.maxBytes = maxBytes;
      const maxFiles = raw.log.maxFiles === undefined ? config.log.maxFiles : posInt(raw.log.maxFiles, 1, 50);
      if (maxFiles === undefined) errors.push("log.maxFiles inválido (1-50).");
      else config.log.maxFiles = maxFiles;
    }
  }

  if (raw.cloud !== undefined) {
    if (!isObj(raw.cloud)) errors.push("cloud inválido.");
    else {
      const url = raw.cloud.url;
      if (url !== undefined && url !== null) {
        if (typeof url === "string" && isValidCloudUrl(url.trim())) config.cloud.url = url.trim().replace(/\/+$/, "");
        else errors.push("cloud.url inválido (tiene que ser https://…/functions/v1).");
      }
      const hb = raw.cloud.heartbeatMs === undefined ? config.cloud.heartbeatMs : posInt(raw.cloud.heartbeatMs, 10_000, 600_000);
      if (hb === undefined) errors.push("cloud.heartbeatMs inválido (10000-600000).");
      else config.cloud.heartbeatMs = hb;
      const wait = raw.cloud.pollWaitSec === undefined ? config.cloud.pollWaitSec : posInt(raw.cloud.pollWaitSec, 0, 25);
      if (wait === undefined) errors.push("cloud.pollWaitSec inválido (0-25).");
      else config.cloud.pollWaitSec = wait;
    }
  }

  if (raw.devices !== undefined) {
    if (!Array.isArray(raw.devices)) errors.push("devices tiene que ser una lista.");
    else {
      const seen = new Set<string>();
      raw.devices.forEach((d, i) => {
        const where = `devices[${i}]`;
        if (!isObj(d)) return errors.push(`${where}: no es un objeto.`);
        const id = typeof d.id === "string" ? d.id.trim() : "";
        if (!ID.test(id)) return errors.push(`${where}: id inválido (letras, números, - y _).`);
        if (seen.has(id)) return errors.push(`${where}: el id "${id}" está repetido.`);
        const name = typeof d.name === "string" && d.name.trim() ? d.name.trim().slice(0, 60) : id;
        const t = d.transport;
        if (!isObj(t)) return errors.push(`${where}: falta transport.`);
        if (t.type === "serial") {
          const path = typeof t.path === "string" ? t.path.trim().toUpperCase() : "";
          if (!/^COM\d{1,3}$/.test(path)) return errors.push(`${where}: transport.path tiene que ser COMn.`);
          const baudRate = posInt(t.baudRate, 1, 1_000_000);
          if (baudRate === undefined || !BAUDS.has(baudRate)) return errors.push(`${where}: baudRate inválido.`);
          const transport: SerialTransport = { type: "serial", path, baudRate };
          if (t.dataBits !== undefined) {
            if (![5, 6, 7, 8].includes(t.dataBits as number)) return errors.push(`${where}: dataBits inválido.`);
            transport.dataBits = t.dataBits as SerialTransport["dataBits"];
          }
          if (t.stopBits !== undefined) {
            if (![1, 1.5, 2].includes(t.stopBits as number)) return errors.push(`${where}: stopBits inválido.`);
            transport.stopBits = t.stopBits as SerialTransport["stopBits"];
          }
          if (t.parity !== undefined) {
            if (!["none", "even", "odd", "mark", "space"].includes(t.parity as string)) return errors.push(`${where}: parity inválido.`);
            transport.parity = t.parity as SerialTransport["parity"];
          }
          seen.add(id);
          config.devices.push({ id, name, transport });
        } else if (t.type === "tcp") {
          const host = typeof t.host === "string" ? t.host.trim() : "";
          if (!isLocalNetworkIPv4(host)) return errors.push(`${where}: host tiene que ser una IP de la red local.`);
          const port = posInt(t.port, 1, 65535);
          if (port === undefined) return errors.push(`${where}: port inválido.`);
          seen.add(id);
          config.devices.push({ id, name, transport: { type: "tcp", host, port } });
        } else {
          errors.push(`${where}: transport.type tiene que ser "serial" o "tcp".`);
        }
        return undefined;
      });
    }
  }

  return { config, errors };
}

export interface LoadedConfig extends ParsedConfig {
  createdDefault: boolean;
}

/** Lee config.json. Si no existe, escribe la de fábrica. */
export async function loadConfig(file: string): Promise<LoadedConfig> {
  const read = await readJsonFile<unknown>(file);
  if (read.status === "missing") {
    await writeFileAtomic(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    return { config: structuredClone(DEFAULT_CONFIG), errors: [], createdDefault: true };
  }
  if (read.status === "corrupt") {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      errors: [`config.json estaba dañado (${read.error}); se apartó como ${read.movedTo} y se usa la de fábrica.`],
      createdDefault: false,
    };
  }
  return { ...parseConfig(read.value), createdDefault: false };
}
