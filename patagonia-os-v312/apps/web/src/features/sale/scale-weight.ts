import type { ScaleFrame } from "./scale-weight-parser";
import { WEIGHT_PORT_OPTIONS, exchangeWeightFrame, weightReadError } from "./scale-weight-protocol";

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
let portIsOpen = false;

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
}

/** La pantalla "Balanzas" (Scale Manager) le pasa acá el puerto de la
 * balanza de peso que ya detectó y que el cajero confirmó, así Mostrador
 * lee de ESA balanza sin tener que configurarla de nuevo en el engranaje. */
export async function setWeightScalePort(port: SerialPort): Promise<void> {
  if (cachedPort === port) return;
  await closePort();
  cachedPort = port;
}

export async function forgetWeightScale(): Promise<void> {
  await closePort();
  cachedPort = null;
}

// Cable desenchufado: el puerto guardado queda muerto. Se olvida para que al
// volver a enchufarlo la próxima lectura tome el puerto nuevo, sin recargar la página.
if (isWeightScaleSupported()) {
  navigator.serial.addEventListener("disconnect", (event) => {
    if (event.target === cachedPort) {
      cachedPort = null;
      portIsOpen = false;
    }
  });
}

async function closePort(): Promise<void> {
  if (cachedPort && portIsOpen) {
    try {
      await cachedPort.close();
    } catch {
      // ya estaba cerrado o roto -- no importa
    }
  }
  portIsOpen = false;
}

async function getPort(): Promise<SerialPort> {
  if (cachedPort) return cachedPort;
  const known = await navigator.serial.getPorts();
  if (known.length === 0) throw new Error("Todavía no conectaste la balanza. Configurala en Producto y stock → Balanzas.");
  if (known.length === 1) {
    cachedPort = known[0];
    return cachedPort;
  }
  return findWeightScalePort(known);
}

/** Con más de un aparato autorizado (ej. la Aura para peso y una Report
 * para PLU en la misma PC) no alcanza con tomar el primero: se le pide el
 * peso a cada uno y se queda con el que responde como balanza de peso.
 * Los puertos que ya tiene abiertos otra parte de la app (ej. la
 * sincronización de PLU) no se tocan, para no cortarle la conexión. */
async function findWeightScalePort(known: SerialPort[]): Promise<SerialPort> {
  for (const port of known) {
    if (port.readable || port.writable) continue;
    try {
      await readOnce(port);
      cachedPort = port;
      return port;
    } catch {
      try {
        await port.close();
      } catch {
        // no llegó a abrirse -- no importa
      }
      portIsOpen = false;
    }
  }
  throw new Error("Hay varios aparatos conectados a la PC y ninguno respondió como balanza de peso. Revisá el cable, o volvé a detectarla en Producto y stock → Balanzas.");
}

async function ensureOpen(port: SerialPort): Promise<void> {
  if (portIsOpen && port.readable && port.writable) return;
  if (port.readable || port.writable) await port.close();
  await port.open(WEIGHT_PORT_OPTIONS);
  portIsOpen = true;
}

async function readOnce(port: SerialPort): Promise<ScaleReading> {
  await ensureOpen(port);
  const { raw, frame } = await exchangeWeightFrame(port);
  if (frame) return { frame, raw };
  throw weightReadError(raw);
}

/** Lee el peso actual de la balanza. Reintenta una vez reabriendo el puerto (un error de cable/adaptador rompe el stream hasta reabrir). */
export async function readScaleWeight(): Promise<ScaleReading> {
  if (!isWeightScaleSupported()) throw new Error("Este navegador no soporta la conexión por cable. Usá Chrome o Edge.");
  const port = await getPort();
  try {
    return await readOnce(port);
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith("La balanza no respondió") || err.message.startsWith("Recibí datos") || err.message.startsWith("Todavía"))) {
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
