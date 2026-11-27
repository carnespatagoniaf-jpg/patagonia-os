// ByteLink: el "enlace de bytes" con una balanza (puerto serie o socket TCP).
// Los protocolos (Kretz, Systel; más adelante en packages/scale-protocols)
// solo ven esta interfaz: abrir, escribir, leer con tiempo de espera, cerrar y
// enterarse de una desconexión.

import { LinkError } from "./link-error";

export interface ReadOptions {
  /** Tiempo máximo de espera, en milisegundos. */
  timeoutMs: number;
  /**
   * Cuándo alcanza con lo recibido (por ejemplo "llegó el EOT"). Por omisión,
   * apenas llega al menos un byte.
   */
  until?: (received: Uint8Array) => boolean;
  /** Cancela la lectura (vigía del trabajo). */
  signal?: AbortSignal;
}

export interface ByteLink {
  /** Descripción para mensajes y bitácora ("COM3", "192.168.0.50:1001"). */
  readonly label: string;
  readonly isOpen: boolean;
  open(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  /**
   * Devuelve (y consume) todo lo recibido cuando `until` se cumple. Si no se
   * cumple a tiempo rechaza con LinkError "timeout" y deja los bytes en el
   * búfer (ver `discardInput`). Una sola lectura a la vez.
   */
  read(options: ReadOptions): Promise<Uint8Array>;
  /** Descarta lo recibido y no leído. Devuelve cuántos bytes se tiraron. */
  discardInput(): number;
  /** Cierra a pedido. No dispara `onDisconnect`. Se puede llamar varias veces. */
  close(): Promise<void>;
  /**
   * Avisa una desconexión NO pedida (cable, balanza apagada, socket cortado).
   * Devuelve la función para dejar de escuchar.
   */
  onDisconnect(listener: (error: LinkError) => void): () => void;
}

/** El enlace se perdió porque no volvió a abrir al cambiarle la configuración (no por un corte). */
export class LinkReopenError extends LinkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("closed", message, options);
  }
}

/** Configuración de la línea serie (velocidad, bits, paridad). */
export interface LineSettings {
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: "none" | "even" | "odd" | "mark" | "space";
}

/** Señales de control del puerto serie (DTR y RTS). */
export interface LineSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
}

/**
 * Enlace serie que se puede reconfigurar sin soltar el puerto: cambiar la velocidad
 * o los bits de stop (cierra y reabre el MISMO puerto, sin pasar por el gestor) y las
 * señales DTR/RTS. Lo usan los protocolos que prueban varias configuraciones (la
 * búsqueda Kretz y Systel). TCP no lo implementa: en la red no hay velocidad.
 */
export interface SerialLineControl {
  readonly lineSettings: LineSettings;
  reconfigure(next: LineSettings): Promise<void>;
  setSignals(signals: LineSignals): Promise<void>;
  /** Fabricante y producto del adaptador USB, si se conocen. */
  readonly usbInfo?: { usbVendorId?: number; usbProductId?: number };
}

export function isSerialLineControl(link: ByteLink): link is ByteLink & SerialLineControl {
  const l = link as Partial<SerialLineControl>;
  return typeof l.reconfigure === "function" && typeof l.setSignals === "function" && !!l.lineSettings;
}

export function sameLineSettings(a: LineSettings, b: LineSettings): boolean {
  return a.baudRate === b.baudRate && a.dataBits === b.dataBits && a.stopBits === b.stopBits && a.parity === b.parity;
}

interface PendingRead {
  until: (received: Uint8Array) => boolean;
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanupSignal?: () => void;
}

const atLeastOneByte = (received: Uint8Array) => received.length > 0;

/**
 * Base común: búfer de entrada, lectura con tiempo de espera, cancelación y
 * aviso de desconexión. Cada transporte implementa solo doOpen/doWrite/doClose
 * y llama a `receive()` y `lost()`.
 */
export abstract class BaseByteLink implements ByteLink {
  abstract readonly label: string;

  private opened = false;
  private closing = false;
  private inbox: Buffer = Buffer.alloc(0);
  private pending: PendingRead | null = null;
  private readonly disconnectListeners = new Set<(error: LinkError) => void>();

  get isOpen(): boolean {
    return this.opened;
  }

  protected abstract doOpen(): Promise<void>;
  protected abstract doWrite(data: Uint8Array): Promise<void>;
  protected abstract doClose(): Promise<void>;

  async open(): Promise<void> {
    if (this.opened) return;
    this.inbox = Buffer.alloc(0);
    this.closing = false;
    await this.doOpen();
    this.opened = true;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.opened) throw new LinkError("closed", `${this.label} no está abierto.`);
    try {
      await this.doWrite(data);
    } catch (error) {
      if (error instanceof LinkError) throw error;
      throw new LinkError("io", `No se pudo escribir en ${this.label}.`, { cause: error });
    }
  }

  read(options: ReadOptions): Promise<Uint8Array> {
    if (!this.opened) return Promise.reject(new LinkError("closed", `${this.label} no está abierto.`));
    if (this.pending) {
      return Promise.reject(new LinkError("io", `Ya hay una lectura en curso en ${this.label}.`));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new LinkError("aborted", "Lectura cancelada."));
    }
    const until = options.until ?? atLeastOneByte;
    if (until(this.inbox)) return Promise.resolve(this.takeInbox());

    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(
          null,
          new LinkError(
            "timeout",
            `${this.label} no respondió en ${options.timeoutMs} ms (llegaron ${this.inbox.length} bytes).`,
          ),
        );
      }, Math.max(0, options.timeoutMs));
      const pending: PendingRead = { until, resolve, reject, timer };
      if (options.signal) {
        const onAbort = () => this.settle(null, new LinkError("aborted", "Lectura cancelada."));
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupSignal = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.pending = pending;
    });
  }

  discardInput(): number {
    const n = this.inbox.length;
    this.inbox = Buffer.alloc(0);
    return n;
  }

  async close(): Promise<void> {
    if (!this.opened && !this.closing) {
      // Puede quedar un transporte a medio abrir: igual se intenta cerrar.
      await this.safeDoClose();
      return;
    }
    this.closing = true;
    this.opened = false;
    this.settle(null, new LinkError("closed", `Se cerró ${this.label}.`));
    await this.safeDoClose();
  }

  onDisconnect(listener: (error: LinkError) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** El transporte llama esto con cada pedazo de bytes que llega. */
  protected receive(chunk: Uint8Array): void {
    if (!this.opened || chunk.length === 0) return;
    this.inbox = Buffer.concat([this.inbox, chunk]);
    const pending = this.pending;
    if (pending && pending.until(this.inbox)) this.settle(this.takeInbox(), null);
  }

  /** El transporte llama esto cuando la conexión se cae sola. */
  protected lost(cause?: unknown): void {
    if (!this.opened || this.closing) return;
    this.opened = false;
    const error = new LinkError("closed", `Se cortó la conexión con ${this.label}.`, { cause });
    this.settle(null, error);
    this.announceLost(error);
    void this.safeDoClose();
  }

  /**
   * Cierra y vuelve a abrir el mismo puerto con otra configuración (la aplica
   * `apply`). Si no vuelve a abrir, avisa una desconexión: así el trabajador
   * suelta el puerto y reconecta con la configuración de siempre.
   */
  protected async reopen(apply: () => void): Promise<void> {
    await this.close();
    apply();
    try {
      await this.open();
    } catch (error) {
      this.announceLost(new LinkReopenError(`No se pudo reabrir ${this.label} con otra configuración.`, { cause: error }));
      throw error;
    }
  }

  private announceLost(error: LinkError): void {
    for (const listener of [...this.disconnectListeners]) {
      try {
        listener(error);
      } catch {
        // Un oyente que falla no puede tumbar al enlace ni a los demás oyentes.
      }
    }
  }

  private takeInbox(): Uint8Array {
    const data = this.inbox;
    this.inbox = Buffer.alloc(0);
    return new Uint8Array(data);
  }

  private settle(data: Uint8Array | null, error: Error | null): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.cleanupSignal?.();
    if (error) pending.reject(error);
    else pending.resolve(data ?? new Uint8Array());
  }

  private async safeDoClose(): Promise<void> {
    try {
      await this.doClose();
    } catch {
      // Cerrar algo que ya se cayó suele fallar; no importa.
    }
  }
}
