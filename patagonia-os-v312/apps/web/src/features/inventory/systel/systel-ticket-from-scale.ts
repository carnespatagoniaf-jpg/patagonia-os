import type { Product } from "@patagonia/domain";
import { SystelClient, type SystelExchangeLog } from "./systel-client";
import { loadSavedSystelLink } from "./systel-discovery";
import { FTDI_VENDOR_ID, SerialSystelLink, type SystelLinkEvent } from "./systel-serial";
import { readTicketDetail, type PluCache, type TicketDetailResult } from "./systel-ticket-detail";
import { saveSystelLabelTemplates } from "../../sale/systel-label-format";
import { registerSerialHolder } from "../kretz/serial-tabs";

/**
 * Mostrador ↔ balanza Systel por cable, para leer el detalle de los tickets de TOTAL.
 *
 * La conexión se abre la primera vez y QUEDA ABIERTA mientras Mostrador está en pantalla (se cierra
 * al salir de Mostrador o si se desenchufa el cable). Por qué: en los registros reales de Los gringos,
 * cada racha de E3 empezó después de una sesión nuestra que anduvo bien y se cerró (13/10: bien 11:52,
 * E3 11:53-12:15, bien 12:16; 09/10: bien 13:08, E3 13:26-13:41). Nuestra forma de trabajar era abrir,
 * subir DTR/RTS, mandar ping a 1 y a 0, y cerrar (DTR/RTS bajan) en cada operación. El programa de
 * ejemplo oficial de Systel abre el puerto una vez y lo deja abierto. No está probado que esa sea la
 * causa: por eso cada intento manda a soporte cuánto pasó desde la última sesión buena y si la
 * conexión estaba recién abierta o ya abierta, para poder distinguirlo con datos reales.
 *
 * Solo lectura (23, 39, 72, 62/3). Usa el puerto que esta computadora YA autorizó (Stock → Balanza)
 * y lo que se guardó ahí (velocidad y N.º de balanza). Nunca abre el selector de puertos.
 */

export function systelTicketReadConfigured(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator && loadSavedSystelLink() !== null;
}

const LAST_OK_KEY = "patagonia-systel-last-ok";

interface Session {
  link: SerialSystelLink;
  client: SystelClient;
  port: SerialPort;
  openedAt: number;
  log: SystelExchangeLog[];
  events: SystelLinkEvent[];
  cache: PluCache;
}

let session: Session | null = null;
let busy: Promise<unknown> = Promise.resolve();

export interface ScaleTicketRead {
  result: TicketDetailResult;
  log: SystelExchangeLog[];
  events: SystelLinkEvent[];
  /** Para entender el E3 con datos reales. */
  context: { freshConnection: boolean; msSinceLastOk: number | null; address: number | null };
}

function pickPort(ports: SerialPort[]): SerialPort | null {
  const ftdi = ports.filter((p) => {
    try {
      return p.getInfo().usbVendorId === FTDI_VENDOR_ID;
    } catch {
      return false;
    }
  });
  return ftdi.length === 1 ? ftdi[0] : ftdi.length === 0 && ports.length === 1 ? ports[0] : null;
}

async function openSession(): Promise<{ session: Session } | { error: string }> {
  const saved = loadSavedSystelLink();
  if (!saved || !("serial" in navigator)) return { error: "esta computadora no tiene la balanza Systel conectada por cable" };
  const port = pickPort(await navigator.serial.getPorts());
  if (!port) return { error: "el cable de la balanza no está conectado (o el puerto no está autorizado en esta computadora)" };
  const events: SystelLinkEvent[] = [];
  const log: SystelExchangeLog[] = [];
  const link = new SerialSystelLink(port, saved.settings, events);
  try {
    await link.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: /already open/i.test(message) ? "el puerto de la balanza está abierto en otra pantalla o programa (por ejemplo Qendra o Stock → Balanza)" : `no se pudo abrir el puerto de la balanza (${message})` };
  }
  // Igual que en todas las sesiones que la balanza real contestó.
  await link.setSignals(true);
  const client = new SystelClient(link, { address: saved.address, log });
  // Secuencia de arranque comprobada en la balanza real, una sola vez por conexión.
  await client.wake();
  return { session: { link, client, port, openedAt: Date.now(), log, events, cache: { layout: null, plus: new Map() } } };
}

/**
 * Al entrar a Mostrador: lee la configuración de la balanza (solo lectura) para saber con qué formato
 * imprime los códigos de cada producto. Si no contesta, se sigue con el formato guardado.
 */
export function refreshSystelLabelFormat(): Promise<void> {
  const run = busy.then(async () => {
    if (!session) {
      const opened = await openSession();
      if ("error" in opened) return;
      session = opened.session;
    }
    const config = await session.client.config().catch(() => null);
    if (config) saveSystelLabelTemplates(config.values);
  });
  busy = run.catch(() => {});
  return run.catch(() => {});
}

/** Cierra la conexión (al salir de Mostrador). */
export async function closeSystelTicketSession(): Promise<void> {
  const s = session;
  session = null;
  if (s) await s.link.close();
}

/**
 * Otra pantalla (Mi balanza, en esta pestaña o en otra) necesita el cable: se suelta cuando termina la lectura que
 * esté en curso. El próximo TOTAL lo vuelve a abrir solo.
 */
export function releaseSystelTicketSession(): Promise<number> {
  const run = busy.then(async () => {
    if (!session) return 0;
    await closeSystelTicketSession();
    return 1;
  });
  busy = run.catch(() => {});
  return run.catch(() => 0);
}

registerSerialHolder(releaseSystelTicketSession);

if (typeof navigator !== "undefined" && "serial" in navigator) {
  navigator.serial.addEventListener("disconnect", (e) => {
    if (session && (e.target as unknown as SerialPort) === session.port) void closeSystelTicketSession();
  });
}

function lastOk(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST_OK_KEY));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function readSystelTicketFromScale(input: {
  code: string;
  amount: number;
  products: Product[];
  usedKeys: Iterable<string>;
  charged?: (keys: string[]) => Promise<Set<string>>;
}): Promise<ScaleTicketRead> {
  // Una lectura por vez en el cable.
  const run = busy.then(() => readNow(input));
  busy = run.catch(() => {});
  return run;
}

async function readNow(input: Parameters<typeof readSystelTicketFromScale>[0]): Promise<ScaleTicketRead> {
  const since = lastOk();
  const msSinceLastOk = since ? Date.now() - since : null;
  let fresh = false;
  if (!session) {
    const opened = await openSession();
    if ("error" in opened) return { result: { ok: false, stage: "lectura", reason: opened.error }, log: [], events: [], context: { freshConnection: true, msSinceLastOk, address: null } };
    session = opened.session;
    fresh = true;
  }
  const s = session;
  const logFrom = s.log.length;
  const eventsFrom = s.events.length;
  let result: TicketDetailResult;
  try {
    // Los productos se releen en cada ticket (alguien pudo cambiarlos en la balanza); el formato no cambia.
    const cache: PluCache = { layout: s.cache.layout, plus: new Map() };
    result = await readTicketDetail(s.client, { ...input, cache, onConfig: saveSystelLabelTemplates });
    s.cache.layout = cache.layout;
  } catch (err) {
    result = { ok: false, stage: "lectura", reason: err instanceof Error ? err.message : String(err) };
  }
  if (result.ok || result.stage !== "lectura") {
    try {
      localStorage.setItem(LAST_OK_KEY, String(Date.now()));
    } catch {
      // nada
    }
  }
  return { result, log: s.log.slice(logFrom), events: s.events.slice(eventsFrom), context: { freshConnection: fresh, msSinceLastOk, address: s.client.address } };
}
