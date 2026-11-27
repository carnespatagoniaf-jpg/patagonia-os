import type { ScaleFrame } from "./scale-weight-parser";
import { WEIGHT_PORT_OPTIONS, exchangeWeightFrame, weightReadError } from "./scale-weight-protocol";
import { ScaleBusyError, isScaleBusyError, serialLockKey, withScaleLock } from "../inventory/kretz/scale-lock";

// Lectura del peso directo de la balanza Kretz Aura Eco por cable RS-232, con la
// Web Serial API (Chrome/Edge), para Mostrador. Cómo se le pide el peso está en
// scale-weight-protocol.ts (compartido con la pantalla Balanzas); acá solo se
// maneja qué puerto usa Mostrador y cuándo se abre.

const ENABLED_KEY = "patagonia-weight-scale-enabled";

export interface ScaleReading {
  frame: ScaleFrame;
  raw: string;
}

export function isWeightScaleSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export function isWeightScaleEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setWeightScaleEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    // localStorage bloqueado -- no crítico, solo no se recuerda la preferencia.
  }
}

let cachedPort: SerialPort | null = null;
/** Los puertos que abrió Mostrador: son los ÚNICOS que cierra (C20: cerraba el de la sincronización de la Report). */
const openedHere = new WeakSet<SerialPort>();

/** El aparato USB de la balanza de peso, recordado en esta computadora (Web Serial no da otro identificador). */
const PORT_KEY = "patagonia-weight-scale-port";
type PortId = { usbVendorId?: number; usbProductId?: number };

function portId(port: SerialPort): PortId | null {
  const i = (port.getInfo?.() ?? {}) as PortId;
  return i.usbVendorId === undefined && i.usbProductId === undefined ? null : { usbVendorId: i.usbVendorId, usbProductId: i.usbProductId };
}

function rememberWeightPort(port: SerialPort): void {
  const id = portId(port);
  if (!id) return;
  try {
    localStorage.setItem(PORT_KEY, JSON.stringify(id));
  } catch {
    // sin localStorage: la próxima vez se vuelve a buscar
  }
}

function rememberedWeightPort(): PortId | null {
  try {
    const raw = localStorage.getItem(PORT_KEY);
    const id = raw ? (JSON.parse(raw) as PortId) : null;
    return id && (id.usbVendorId !== undefined || id.usbProductId !== undefined) ? id : null;
  } catch {
    return null;
  }
}

function forgetRememberedPort(): void {
  try {
    localStorage.removeItem(PORT_KEY);
  } catch {
    // nada que olvidar
  }
}

/** ¿Lo tiene abierto otra parte (u otra pestaña lo abrió en este mismo objeto)? */
function openElsewhere(port: SerialPort): boolean {
  return !openedHere.has(port) && Boolean(port.readable || port.writable);
}

const BUSY_MESSAGE = "La balanza de peso la tiene abierta otra parte del sistema (por ejemplo, pasando productos a la balanza). Esperá a que termine y probá de nuevo.";

export async function isWeightScalePaired(): Promise<boolean> {
  if (!isWeightScaleSupported()) return false;
  if (cachedPort) return true;
  return (await navigator.serial.getPorts()).length > 0;
}

/** Tiene que llamarse desde un click: el navegador exige un gesto del usuario para mostrar el selector de puerto. */
export async function connectWeightScale(): Promise<void> {
  if (!isWeightScaleSupported()) throw new Error("Este navegador no soporta la conexión por cable. Usá Chrome o Edge.");
  await closePort();
  cachedPort = await navigator.serial.requestPort();
  rememberWeightPort(cachedPort);
}

/** La pantalla "Balanzas" (Scale Manager) le pasa acá el puerto de la
 * balanza de peso que ya detectó y que el cajero confirmó, así Mostrador
 * lee de ESA balanza sin tener que configurarla de nuevo en el engranaje. */
export async function setWeightScalePort(port: SerialPort): Promise<void> {
  if (cachedPort === port) return;
  await closePort();
  cachedPort = port;
  rememberWeightPort(port);
}

export async function forgetWeightScale(): Promise<void> {
  await closePort();
  cachedPort = null;
  forgetRememberedPort();
}

// Cable desenchufado: el puerto guardado queda muerto. Se olvida para que al
// volver a enchufarlo la próxima lectura tome el puerto nuevo, sin recargar la página.
if (isWeightScaleSupported()) {
  navigator.serial.addEventListener("disconnect", (event) => {
    if (event.target === cachedPort) {
      if (cachedPort) openedHere.delete(cachedPort);
      cachedPort = null;
    }
  });
}

/** Cierra el puerto de Mostrador, solo si lo abrió Mostrador. */
async function closePort(): Promise<void> {
  await closeIfMine(cachedPort);
}

async function closeIfMine(port: SerialPort | null): Promise<void> {
  if (!port || !openedHere.has(port)) return;
  openedHere.delete(port);
  try {
    await port.close();
  } catch {
    // ya estaba cerrado o roto -- no importa
  }
}

const samePortId = (a: PortId | null, b: PortId) => !!a && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;

/**
 * El puerto de la balanza de peso: el marcado (engranaje de Mostrador o pantalla Balanzas) o el recordado en esta
 * computadora. Si no hay ninguno, se busca preguntándole el peso a los puertos que nadie tiene abiertos, y el que
 * contesta queda recordado. Antes, con un solo puerto autorizado se tomaba ese aunque fuera la Report.
 */
async function getPort(): Promise<SerialPort> {
  if (cachedPort) return cachedPort;
  const known = await navigator.serial.getPorts();
  if (known.length === 0) throw new Error("Todavía no conectaste la balanza. Configurala en Mostrador → engranaje → “Peso directo de la balanza”.");
  const remembered = rememberedWeightPort();
  if (remembered) {
    const same = known.filter((p) => samePortId(portId(p), remembered));
    if (same.length === 1) {
      cachedPort = same[0];
      return cachedPort;
    }
    if (same.length > 1) return findWeightScalePort(same);
  }
  return findWeightScalePort(known);
}

/** Sin puerto marcado ni recordado (o con dos adaptadores iguales): se le
 * pide el peso a cada uno y se queda con el que responde como balanza de
 * peso. Los puertos que ya tiene abiertos otra parte de la app (ej. la
 * sincronización de PLU) no se tocan, para no cortarle la conexión. */
async function findWeightScalePort(known: SerialPort[]): Promise<SerialPort> {
  let busy = 0;
  let lastErr: unknown = null;
  for (const port of known) {
    if (openElsewhere(port)) {
      busy++;
      continue;
    }
    try {
      await readOnce(port);
      cachedPort = port;
      rememberWeightPort(port);
      return port;
    } catch (err) {
      if (isScaleBusyError(err)) {
        busy++;
        continue;
      }
      lastErr = err;
      await closeIfMine(port);
    }
  }
  if (busy > 0) throw new ScaleBusyError(BUSY_MESSAGE);
  // Con un solo aparato, el error tal cual (dice qué le pasó a la balanza).
  if (known.length === 1 && lastErr) throw lastErr;
  throw new Error("Hay varios aparatos conectados a la PC y ninguno respondió como balanza de peso. Revisá el cable, o volvé a conectarla en Mostrador → engranaje → “Peso directo de la balanza”.");
}

/** Abre el puerto a 9600 solo si está cerrado. Si lo tiene abierto otra parte (otra velocidad, otro módulo), NO lo cierra. */
async function ensureOpen(port: SerialPort): Promise<void> {
  if (openedHere.has(port) && port.readable && port.writable) return;
  if (openElsewhere(port)) throw new ScaleBusyError(BUSY_MESSAGE);
  if (openedHere.has(port)) await closeIfMine(port); // quedó a medias: es nuestro, se reabre
  await port.open(WEIGHT_PORT_OPTIONS);
  openedHere.add(port);
}

/** Una pesada, con el candado del puerto (entre pestañas, scale-lock.ts): nadie más le habla en el medio. */
async function readOnce(port: SerialPort): Promise<ScaleReading> {
  return withScaleLock(
    serialLockKey(port),
    async () => {
      await ensureOpen(port);
      const { raw, frame } = await exchangeWeightFrame(port);
      if (frame) return { frame, raw };
      throw weightReadError(raw);
    },
    { waitMs: 3000 }
  );
}

/** Después de leer, el puerto se cierra solo a los pocos segundos sin uso.
 * Antes quedaba abierto todo el día: mientras Mostrador estaba abierto en
 * una pestaña, ninguna otra pestaña ni programa podía abrir esa balanza
 * (Windows contesta "Failed to open serial port"). Caso real: Aura de una
 * clienta, 2026-10-01/02. Reabrir para la próxima pesada tarda milisegundos. */
let idleCloseMs = 10_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Solo para tests. */
export function setWeightIdleCloseMs(ms: number): void {
  idleCloseMs = ms;
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void closePort();
  }, idleCloseMs);
  (idleTimer as { unref?: () => void }).unref?.();
}

/** Lee el peso actual de la balanza. Reintenta una vez reabriendo el puerto (un error de cable/adaptador rompe el stream hasta reabrir). */
export async function readScaleWeight(): Promise<ScaleReading> {
  if (!isWeightScaleSupported()) throw new Error("Este navegador no soporta la conexión por cable. Usá Chrome o Edge.");
  if (idleTimer) clearTimeout(idleTimer); // que no se cierre en medio de esta lectura
  idleTimer = null;
  try {
    return await readScaleWeightNow();
  } finally {
    scheduleIdleClose();
  }
}

async function readScaleWeightNow(): Promise<ScaleReading> {
  const port = await getPort();
  try {
    return await readOnce(port);
  } catch (err) {
    if (isScaleBusyError(err) || (err instanceof Error && (err.message.startsWith("La balanza no respondió") || err.message.startsWith("Recibí datos") || err.message.startsWith("Todavía")))) {
      throw err;
    }
    await closePort();
    try {
      return await readOnce(port);
    } catch (retryErr) {
      throw retryErr instanceof Error ? retryErr : err;
    }
  }
}
