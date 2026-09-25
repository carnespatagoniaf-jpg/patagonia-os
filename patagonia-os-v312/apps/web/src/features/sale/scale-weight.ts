import { bytesToText, describeRawFrame, parseScaleFrame, type ScaleFrame } from "./scale-weight-parser";

// Lectura del peso directo de la balanza Kretz Aura Eco por cable RS-232, con la
// Web Serial API (Chrome/Edge). Parámetros del manual de la Aura Eco (sección
// 16.5): 9600 baudios, 8 bits de datos, sin paridad, 2 bits de stop. La balanza
// tiene que estar en el menú COMUNI -> MODO = "A pedido de peso" (le pedimos el
// peso mandando una "W"; en modo continuo también anda porque transmite sola).

const PORT_OPTIONS: SerialOptions = { baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" };
const REQUEST_BYTE = 0x57; // "W" (el manual acepta P, p, W o w)
const READ_TIMEOUT_MS = 1800;
const DRAIN_MS = 60;
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

export async function forgetWeightScale(): Promise<void> {
  await closePort();
  cachedPort = null;
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
  if (known.length === 0) throw new Error("Todavía no conectaste la balanza. Tocá \"Conectar balanza\" en el engranaje de Mostrador.");
  cachedPort = known[0];
  return cachedPort;
}

async function ensureOpen(port: SerialPort): Promise<void> {
  if (portIsOpen && port.readable && port.writable) return;
  if (port.readable || port.writable) await port.close();
  await port.open(PORT_OPTIONS);
  portIsOpen = true;
}

type ChunkResult = { value?: Uint8Array; done: boolean; timedOut?: boolean };

/** Lector con tiempo de espera. Mantiene UNA sola lectura pendiente y la reutiliza
 * en la llamada siguiente: si al vencer el tiempo se dejara colgada una lectura
 * y se pidiera otra, la colgada se "comería" los datos que lleguen después. */
function makeTimedReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let pending: Promise<ChunkResult> | null = null;
  return (ms: number): Promise<ChunkResult> => {
    if (!pending) {
      pending = reader
        .read()
        .then((r): ChunkResult => ({ value: r.value, done: r.done }))
        .catch((): ChunkResult => ({ done: true }));
    }
    const current = pending;
    return Promise.race([
      current.then((r) => {
        if (pending === current) pending = null;
        return r;
      }),
      new Promise<ChunkResult>((resolve) => setTimeout(() => resolve({ done: false, timedOut: true }), Math.max(ms, 1)))
    ]);
  };
}

async function readOnce(port: SerialPort): Promise<ScaleReading> {
  await ensureOpen(port);
  const reader = port.readable!.getReader();
  const readWithTimeout = makeTimedReader(reader);
  try {
    // 1) Descartar lo que haya quedado viejo en el buffer (en modo continuo la
    //    balanza transmite sola): sin esto se podría leer el peso del producto anterior.
    for (;;) {
      const stale = await readWithTimeout(DRAIN_MS);
      if (stale.timedOut || stale.done || !stale.value?.length) break;
    }

    // 2) Pedir el peso.
    const writer = port.writable!.getWriter();
    try {
      await writer.write(new Uint8Array([REQUEST_BYTE]));
    } finally {
      writer.releaseLock();
    }

    // 3) Juntar la respuesta hasta tener un mensaje completo.
    let received: number[] = [];
    const deadline = Date.now() + READ_TIMEOUT_MS;
    let frame: ScaleFrame | null = null;
    while (Date.now() < deadline) {
      const chunk = await readWithTimeout(deadline - Date.now());
      if (chunk.done) break;
      if (chunk.timedOut || !chunk.value) break;
      received = received.concat(Array.from(chunk.value));
      frame = parseScaleFrame(bytesToText(received));
      if (frame) {
        // En los modos con precio e importe el resto llega enseguida: darle un instante.
        if (frame.price === undefined) {
          const more = await readWithTimeout(120);
          if (more.value) received = received.concat(Array.from(more.value));
          frame = parseScaleFrame(bytesToText(received)) ?? frame;
        }
        break;
      }
    }

    const raw = bytesToText(received);
    if (frame) return { frame, raw };
    if (received.length === 0) {
      throw new Error("La balanza no respondió. Revisá el cable, que esté en el menú COMUNI → \"A pedido de peso\", y que el peso esté quieto (estable).");
    }
    throw new Error(`Recibí datos de la balanza pero no pude leer el peso: ${describeRawFrame(raw)}`);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // lectura pendiente al cerrar -- el navegador la cancela solo
    }
  }
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
