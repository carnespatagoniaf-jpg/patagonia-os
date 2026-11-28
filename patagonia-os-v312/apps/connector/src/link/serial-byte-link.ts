// SerialByteLink: balanza por puerto serie (COM nativo, adaptador USB o
// Bluetooth SPP) con el módulo `serialport`.

import { BaseByteLink, sameLineSettings, type LineSettings, type LineSignals, type SerialLineControl } from "./byte-link";
import { LinkError, classifyOpenError } from "./link-error";
import { loadSerialport } from "../native/serialport-loader";

/** Lo mínimo que se usa de la clase SerialPort (permite inyectar SerialPortMock en pruebas). */
export interface SerialPortLike {
  readonly isOpen: boolean;
  open(callback: (error: Error | null) => void): void;
  write(data: Uint8Array, callback: (error: Error | null | undefined) => void): boolean;
  drain(callback: (error: Error | null) => void): void;
  close(callback: (error: Error | null) => void): void;
  /** DTR/RTS (serialport: `port.set`). Opcional: SerialPortMock no siempre lo trae. */
  set?(options: { dtr?: boolean; rts?: boolean }, callback: (error: Error | null) => void): void;
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "close", listener: (error?: Error & { disconnected?: boolean }) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeAllListeners(): this;
}

export interface SerialOpenSettings {
  path: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: "none" | "even" | "odd" | "mark" | "space";
}

export type SerialPortFactory = (settings: Required<SerialOpenSettings>) => SerialPortLike;

export interface SerialByteLinkOptions extends SerialOpenSettings {
  /** Para pruebas: crea el puerto (por ejemplo con SerialPortMock). */
  createPort?: SerialPortFactory;
  /** Fabricante y producto del adaptador USB (del descubridor), si se conocen. */
  usbInfo?: { usbVendorId?: number; usbProductId?: number };
}

const defaultFactory = async (): Promise<SerialPortFactory> => {
  const { SerialPort } = await loadSerialport();
  return (s) => new SerialPort({ ...s, autoOpen: false }) as unknown as SerialPortLike;
};

export class SerialByteLink extends BaseByteLink implements SerialLineControl {
  readonly label: string;
  readonly usbInfo?: { usbVendorId?: number; usbProductId?: number };
  private port: SerialPortLike | null = null;
  private settings: Required<SerialOpenSettings>;
  private readonly createPort?: SerialPortFactory;

  constructor(options: SerialByteLinkOptions) {
    super();
    this.settings = {
      path: options.path,
      baudRate: options.baudRate,
      dataBits: options.dataBits ?? 8,
      stopBits: options.stopBits ?? 1,
      parity: options.parity ?? "none",
    };
    this.createPort = options.createPort;
    this.usbInfo = options.usbInfo;
    this.label = `el puerto ${options.path}`;
  }

  get lineSettings(): LineSettings {
    const { baudRate, dataBits, stopBits, parity } = this.settings;
    return { baudRate, dataBits, stopBits, parity };
  }

  /** Otra velocidad/bits: cierra y reabre el mismo puerto (Windows no cambia los bits de stop en caliente). */
  async reconfigure(next: LineSettings): Promise<void> {
    if (this.isOpen && sameLineSettings(this.lineSettings, next)) return;
    await this.reopen(() => {
      this.settings = { ...this.settings, ...next };
    });
  }

  async setSignals(signals: LineSignals): Promise<void> {
    const port = this.port;
    if (!port?.set) return;
    const options: { dtr?: boolean; rts?: boolean } = {};
    if (signals.dataTerminalReady !== undefined) options.dtr = signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) options.rts = signals.requestToSend;
    await new Promise<void>((resolve, reject) => port.set!(options, (error) => (error ? reject(error) : resolve())));
  }

  protected async doOpen(): Promise<void> {
    let factory: SerialPortFactory;
    try {
      factory = this.createPort ?? (await defaultFactory());
    } catch (error) {
      throw new LinkError("io", "No se pudo cargar el módulo de puertos serie (serialport).", { cause: error });
    }
    const port = factory(this.settings);
    await new Promise<void>((resolve, reject) => {
      port.open((error) => (error ? reject(classifyOpenError(error, this.label)) : resolve()));
    });
    port.on("data", (chunk) => this.receive(chunk));
    port.on("close", (error) => {
      // serialport avisa "disconnected" cuando se desenchufa el adaptador.
      this.lost(error ?? new Error("se cerró el puerto"));
    });
    port.on("error", (error) => this.lost(error));
    this.port = port;
  }

  protected doWrite(data: Uint8Array): Promise<void> {
    const port = this.port;
    if (!port) return Promise.reject(new LinkError("closed", `${this.label} no está abierto.`));
    return new Promise<void>((resolve, reject) => {
      port.write(data, (error) => {
        if (error) return reject(error);
        // drain: espera a que el sistema operativo haya mandado los bytes.
        port.drain((drainError) => (drainError ? reject(drainError) : resolve()));
      });
    });
  }

  protected async doClose(): Promise<void> {
    const port = this.port;
    this.port = null;
    if (!port) return;
    if (port.isOpen) {
      await new Promise<void>((resolve) => port.close(() => resolve()));
    }
    port.removeAllListeners();
  }
}
