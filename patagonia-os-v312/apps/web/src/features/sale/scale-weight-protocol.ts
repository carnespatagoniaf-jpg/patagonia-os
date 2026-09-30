import { bytesToText, describeRawFrame, parseScaleFrame, type ScaleFrame } from "./scale-weight-parser";

// Cómo se le pide el peso a la Kretz Aura Eco por cable. Una sola copia,
// usada por Mostrador (`scale-weight.ts`) y por el driver de la pantalla
// Balanzas (`features/scales/drivers/kretz-aura-weight.ts`), para que las
// dos nunca lean distinto. Cada una abre el puerto a su manera (Mostrador
// guarda su propio puerto; el driver recibe el que le pasa el Manager), por
// eso acá se asume que el puerto ya está abierto con PORT_OPTIONS.
//
// Parámetros del manual de la Aura Eco (sección 16.5): 9600 baudios, 8 bits
// de datos, sin paridad, 2 bits de stop. La balanza tiene que estar en el
// menú COMUNI -> MODO = "A pedido de peso" (le pedimos el peso mandando una
// "W"; en modo continuo también anda porque transmite sola).

export const WEIGHT_PORT_OPTIONS: SerialOptions = { baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" };
const REQUEST_BYTE = 0x57; // "W" (el manual acepta P, p, W o w)
const READ_TIMEOUT_MS = 1800;
const DRAIN_MS = 60;

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

/** Le pide el peso a la balanza (puerto ya abierto) y devuelve lo recibido.
 * `frame` es null si no llegó nada o no se pudo leer un peso: quien llama
 * decide si eso es un error (ver `weightReadError`). */
export async function exchangeWeightFrame(port: SerialPort): Promise<{ raw: string; frame: ScaleFrame | null }> {
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
      if (chunk.done || chunk.timedOut || !chunk.value) break;
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
    return { raw: bytesToText(received), frame };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // lectura pendiente al cerrar -- el navegador la cancela solo
    }
  }
}

/** El error que se le muestra al cajero cuando no se pudo leer un peso. */
export function weightReadError(raw: string): Error {
  if (raw.length === 0) {
    return new Error("La balanza no respondió. Revisá el cable, que esté en el menú COMUNI → \"A pedido de peso\", y que el peso esté quieto (estable).");
  }
  return new Error(`Recibí datos de la balanza pero no pude leer el peso: ${describeRawFrame(raw)}`);
}
