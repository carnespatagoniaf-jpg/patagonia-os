import { bytesToText, describeRawFrame, parseScaleFrame } from "../../sale/scale-weight-parser";
import type { ScaleDriver, ScaleIdentifyResult, ScaleWeightReading } from "../types";

/**
 * Driver del Scale Manager para la Kretz Aura Eco (peso en vivo por cable).
 * NO reimplementa el protocolo: la trama, los tiempos y el manejo del
 * puerto siguen viviendo, tal cual, en `features/sale/scale-weight.ts` +
 * `scale-weight-parser.ts` (ya probados y en uso real) -- este archivo es
 * solo una envoltura fina que expone esas mismas funciones bajo la
 * interfaz `ScaleDriver`. La pantalla actual (`ScaleWeightSettings.tsx`,
 * en el engranaje de Mostrador) sigue llamando a `scale-weight.ts`
 * directamente. La pantalla "Balanzas" usa este driver para detectar y
 * probar, y al guardar le pasa el puerto a `scale-weight.ts`
 * (`setWeightScalePort`), que es quien lee el peso al vender.
 *
 * Parámetros: manual Aura Eco Rev.01 sección 16.5 -- 9600 baudios, 8 bits
 * de datos, sin paridad, 2 bits de stop. La balanza tiene que estar en
 * COMUNI -> MODO = "A pedido de peso" (se le pide el peso mandando "W";
 * en modo continuo también responde porque transmite sola).
 */

const PORT_OPTIONS: SerialOptions = { baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" };
const REQUEST_BYTE = 0x57; // "W"
const IDENTIFY_TIMEOUT_MS = 1800;

async function ensureOpen(port: SerialPort): Promise<void> {
  if (port.readable && port.writable) return;
  if (port.readable || port.writable) await port.close();
  await port.open(PORT_OPTIONS);
}

type ChunkResult = { value?: Uint8Array; done: boolean; timedOut?: boolean };

/** Mismo lector con timeout de `scale-weight.ts` (evita que una lectura
 * pendiente al vencer el tiempo se "coma" los bytes del próximo pedido) --
 * duplicado acá a propósito, no importado, porque `readOnce` de ese
 * archivo no está exportado (es intencional: ese módulo cachea su propio
 * puerto/estado y no debe compartirlo con este driver, que recibe el
 * puerto de afuera, del Manager). */
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

async function requestWeight(port: SerialPort, timeoutMs: number): Promise<{ text: string; matched: boolean; frame: ReturnType<typeof parseScaleFrame> }> {
  await ensureOpen(port);
  const reader = port.readable!.getReader();
  const readWithTimeout = makeTimedReader(reader);
  try {
    for (;;) {
      const stale = await readWithTimeout(60);
      if (stale.timedOut || stale.done || !stale.value?.length) break;
    }

    const writer = port.writable!.getWriter();
    try {
      await writer.write(new Uint8Array([REQUEST_BYTE]));
    } finally {
      writer.releaseLock();
    }

    let received: number[] = [];
    const deadline = Date.now() + timeoutMs;
    let frame: ReturnType<typeof parseScaleFrame> = null;
    while (Date.now() < deadline) {
      const chunk = await readWithTimeout(deadline - Date.now());
      if (chunk.done || chunk.timedOut || !chunk.value) break;
      received = received.concat(Array.from(chunk.value));
      frame = parseScaleFrame(bytesToText(received));
      if (frame) {
        if (frame.price === undefined) {
          const more = await readWithTimeout(120);
          if (more.value) received = received.concat(Array.from(more.value));
          frame = parseScaleFrame(bytesToText(received)) ?? frame;
        }
        break;
      }
    }
    const text = bytesToText(received);
    return { text, matched: frame !== null, frame };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // lectura pendiente al cerrar -- el navegador la cancela solo
    }
  }
}

export const kretzAuraWeightDriver: ScaleDriver = {
  id: "kretz-aura-weight",
  brand: "Kretz",
  models: ["Aura Eco", "Aura"],
  status: "certified",
  capabilities: ["readWeight"],

  async identify(port, onProgress): Promise<ScaleIdentifyResult> {
    onProgress?.("Probando Kretz Aura Eco (9600 baudios, pedido de peso)…");
    try {
      const { text, matched } = await requestWeight(port, IDENTIFY_TIMEOUT_MS);
      if (matched) {
        return { matched: true, displayName: "Kretz Aura Eco", settings: {}, debug: describeRawFrame(text) };
      }
      return { matched: false, debug: text ? describeRawFrame(text) : "sin respuesta" };
    } catch (err) {
      return { matched: false, debug: err instanceof Error ? err.message : String(err) };
    }
  },

  async readWeight(port): Promise<ScaleWeightReading> {
    const { text, frame } = await requestWeight(port, IDENTIFY_TIMEOUT_MS);
    if (frame) return { weightKg: frame.weightKg, price: frame.price, amount: frame.amount, raw: text };
    if (text.length === 0) {
      throw new Error("La balanza no respondió. Revisá el cable, que esté en el menú COMUNI → \"A pedido de peso\", y que el peso esté quieto (estable).");
    }
    throw new Error(`Recibí datos de la balanza pero no pude leer el peso: ${describeRawFrame(text)}`);
  }
};
