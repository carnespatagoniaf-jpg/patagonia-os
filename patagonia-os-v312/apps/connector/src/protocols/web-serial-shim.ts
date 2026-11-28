// WebSerialPortShim: un objeto con la forma de `SerialPort` de Web Serial (el de
// Chrome) montado sobre un ByteLink del conector. Con esto el código de
// protocolos de la web (scale-serial.ts, kretz/discovery.ts, systel-serial.ts…)
// corre en Node SIN cambios, igual que `NetScalePort` (inventory/kretz/net-port.ts)
// lo hace sobre HTTP en el navegador.
//
// Reglas:
// - El dueño del puerto es el trabajador de la balanza (PortManager). El shim
//   nunca abre ni cierra el puerto "de verdad": `open()` solo arma los streams
//   sobre el enlace que el trabajo le prestó (`attach`). Cambiar la velocidad o
//   los bits de stop sí reabre el MISMO puerto (SerialLineControl.reconfigure),
//   como pasa en Chrome cuando la búsqueda Kretz prueba otra configuración.
// - Fuera de un trabajo (`detach`), abrir falla como un puerto tomado: el
//   protocolo no puede hablar con la balanza por su cuenta.
// - Si el enlace se corta, el shim queda "perdido" hasta el próximo trabajo:
//   nunca reabre un puerto que el trabajador ya soltó.
// - Cada byte que llega cuenta como avance para el vigía (`onActivity`).

import { isSerialLineControl, sameLineSettings, type ByteLink, type LineSettings } from "../link/byte-link";
import { isLinkError, type LinkError } from "../link/link-error";

export interface SerialOptionsLike {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  bufferSize?: number;
  flowControl?: string;
}

export interface SerialSignalsLike {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

export interface SerialPortInfoLike {
  usbVendorId?: number;
  usbProductId?: number;
}

/** Lo que el trabajo le presta al shim mientras dura. */
export interface ShimBinding {
  link: ByteLink;
  /** El vigía o el apagado cancelan todo lo pendiente. */
  signal: AbortSignal;
  /** Llegaron bytes: el trabajo avanza. */
  onActivity?: () => void;
}

/** Cada cuánto se renueva una lectura pendiente del enlace (no es un tiempo de espera del protocolo). */
const READ_SLICE_MS = 1000;

export function webError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function toLineSettings(options: SerialOptionsLike, current: LineSettings): LineSettings {
  const dataBits = options.dataBits === 7 || options.dataBits === 6 || options.dataBits === 5 ? options.dataBits : 8;
  const stopBits = options.stopBits === 2 ? 2 : 1;
  const parity = options.parity === "even" || options.parity === "odd" ? options.parity : "none";
  return { ...current, baudRate: options.baudRate, dataBits, stopBits, parity };
}

interface OpenSession {
  link: ByteLink;
  binding: ShimBinding;
  /** Se aborta al cerrar el puerto. */
  closed: AbortController;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

export class WebSerialPortShim extends EventTarget {
  /** Para soporte y pruebas: cada `open()` con su configuración. */
  readonly openLog: { at: string; options: SerialOptionsLike; ok: boolean; error?: string }[] = [];
  /** Señales que pidió el protocolo (DTR/RTS). */
  readonly signalLog: SerialSignalsLike[] = [];
  onconnect: ((event: Event) => void) | null = null;
  ondisconnect: ((event: Event) => void) | null = null;

  private binding: ShimBinding | null = null;
  private stopWatching: (() => void) | null = null;
  private session: OpenSession | null = null;
  private lostError: LinkError | null = null;

  constructor(
    private readonly info: SerialPortInfoLike = {},
    readonly label = "balanza",
  ) {
    super();
  }

  /** false = se desconectó durante este trabajo (Web Serial: `port.connected`). */
  get connected(): boolean {
    return this.lostError === null;
  }

  /** Si se cortó el enlace durante el trabajo, el error del corte. */
  get lost(): LinkError | null {
    return this.lostError;
  }

  /** El trabajo le presta el enlace. */
  attach(binding: ShimBinding): void {
    this.detachSync();
    this.binding = binding;
    this.lostError = null;
    this.stopWatching = binding.link.onDisconnect((error) => this.markLost(error));
  }

  /** Termina el trabajo: se cierran los streams y el protocolo ya no puede hablar. */
  async detach(): Promise<void> {
    await this.close().catch(() => undefined);
    this.detachSync();
  }

  private detachSync(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.binding = null;
  }

  getInfo(): SerialPortInfoLike {
    return { ...this.info };
  }

  get readable(): ReadableStream<Uint8Array> | null {
    const s = this.session;
    if (!s || this.lostError) return s?.readable ?? null;
    // Como en Chrome: después de cancelar o de un error, se pide uno nuevo.
    if (!s.readable) s.readable = this.makeReadable(s);
    return s.readable;
  }

  get writable(): WritableStream<Uint8Array> | null {
    const s = this.session;
    if (!s || this.lostError) return s?.writable ?? null;
    if (!s.writable) s.writable = this.makeWritable(s);
    return s.writable;
  }

  async open(options: SerialOptionsLike): Promise<void> {
    const note = (ok: boolean, error?: unknown) =>
      this.openLog.push({ at: new Date().toISOString(), options: { ...options }, ok, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) });
    if (this.session) {
      const error = webError("InvalidStateError", "Failed to execute 'open' on 'SerialPort': The port is already open.");
      note(false, error);
      throw error;
    }
    const binding = this.binding;
    if (!binding || binding.signal.aborted) {
      const error = webError("NetworkError", "Failed to open serial port. (Patagonia Scale Connect: no hay un trabajo en curso con esta balanza)");
      note(false, error);
      throw error;
    }
    if (this.lostError || !binding.link.isOpen) {
      const error = webError("NetworkError", "Failed to open serial port. (se desconectó la balanza)");
      note(false, error);
      throw error;
    }
    const link = binding.link;
    if (isSerialLineControl(link)) {
      const next = toLineSettings(options, link.lineSettings);
      if (!sameLineSettings(next, link.lineSettings)) {
        try {
          await link.reconfigure(next);
        } catch (cause) {
          const why = cause instanceof Error ? cause.message : String(cause);
          const error = webError("NetworkError", `Failed to open serial port. (${why})`);
          note(false, error);
          throw error;
        }
      }
    }
    this.session = { link, binding, closed: new AbortController(), readable: null, writable: null };
    note(true);
  }

  async setSignals(signals: SerialSignalsLike): Promise<void> {
    const s = this.session;
    if (!s) throw webError("InvalidStateError", "Failed to execute 'setSignals' on 'SerialPort': The port is closed.");
    this.signalLog.push({ ...signals });
    if (isSerialLineControl(s.link)) {
      await s.link.setSignals({ dataTerminalReady: signals.dataTerminalReady, requestToSend: signals.requestToSend });
    }
  }

  async getSignals(): Promise<{ dataCarrierDetect: boolean; clearToSend: boolean; ringIndicator: boolean; dataSetReady: boolean }> {
    return { dataCarrierDetect: false, clearToSend: true, ringIndicator: false, dataSetReady: true };
  }

  /** Cierra los streams. El puerto sigue siendo del trabajador: no se suelta. */
  async close(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = null;
    s.closed.abort();
    s.readable = null;
    s.writable = null;
  }

  async forget(): Promise<void> {
    await this.close();
  }

  private markLost(error: LinkError): void {
    if (this.lostError) return;
    this.lostError = error;
    const event = new Event("disconnect");
    this.dispatchEvent(event);
    try {
      this.ondisconnect?.(event);
    } catch {
      // un oyente que falla no importa
    }
  }

  private makeReadable(s: OpenSession): ReadableStream<Uint8Array> {
    // Cada stream tiene su propio corte: cancelarlo suelta la lectura pendiente del
    // enlace al instante (el enlace acepta una sola lectura a la vez).
    const own = new AbortController();
    const signal = AbortSignal.any([own.signal, s.closed.signal, s.binding.signal]);
    let stream: ReadableStream<Uint8Array>;
    const retire = () => {
      if (s.readable === stream) s.readable = null;
    };
    stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          for (;;) {
            if (signal.aborted) {
              retire();
              if (s.closed.signal.aborted || own.signal.aborted) return;
              controller.error(webError("AbortError", "Se canceló el trabajo de la balanza."));
              return;
            }
            try {
              const data = await s.link.read({ timeoutMs: READ_SLICE_MS, signal });
              if (data.length === 0) continue;
              s.binding.onActivity?.();
              controller.enqueue(data);
              return;
            } catch (error) {
              if (isLinkError(error, "timeout")) continue;
              if (isLinkError(error, "aborted")) continue;
              retire();
              if (isLinkError(error, "closed")) this.markLost(error);
              controller.error(webError("NetworkError", "The device has been lost."));
              return;
            }
          }
        },
        cancel: () => {
          own.abort();
          retire();
        },
      },
      { highWaterMark: 0 },
    );
    return stream;
  }

  private makeWritable(s: OpenSession): WritableStream<Uint8Array> {
    let stream: WritableStream<Uint8Array>;
    const retire = () => {
      if (s.writable === stream) s.writable = null;
    };
    stream = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (s.binding.signal.aborted || s.closed.signal.aborted) {
          retire();
          throw webError("InvalidStateError", "The port is closed.");
        }
        try {
          await s.link.write(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayLike<number>));
        } catch (error) {
          retire();
          if (isLinkError(error, "closed")) this.markLost(error);
          throw webError("NetworkError", error instanceof Error ? error.message : String(error));
        }
      },
      close: () => retire(),
      abort: () => retire(),
    });
    return stream;
  }
}
