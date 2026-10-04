import type { SystelLink } from "./systel-client";

/**
 * Conexión por cable con una Systel desde Chrome (Web Serial).
 * Cuora Max por USB: chip FTDI FT232 (DOCUMENTADO, instructivo de drivers) → puerto COM.
 * 115200 baudios, 8 bits (programa de ejemplo oficial); paridad y stop no figuran
 * (por defecto sin paridad y 1 stop): HIPÓTESIS hasta la prueba real.
 * La trama termina por silencio, así que se junta todo lo que llega hasta que la
 * línea queda quieta un rato.
 *
 * Si el cable se desconecta, la próxima orden reabre el puerto una vez (el mismo
 * puerto ya autorizado). Una escritura sin respuesta NO se reenvía acá: el cliente relee.
 */

export const FTDI_VENDOR_ID = 0x0403;

export interface SystelSerialSettings {
  baudRate: number;
  stopBits: 1 | 2;
  parity: "none" | "even" | "odd";
}

export const CUORA_SERIAL: SystelSerialSettings = { baudRate: 115200, stopBits: 1, parity: "none" };

export class SerialSystelLink implements SystelLink {
  private buffer: number[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private reading: Promise<void> | null = null;
  private open = false;
  private lost = false;

  constructor(private port: SerialPort, private readonly settings: SystelSerialSettings = CUORA_SERIAL) {}

  async connect(): Promise<void> {
    if (this.open) return;
    await this.port.open({ baudRate: this.settings.baudRate, dataBits: 8, stopBits: this.settings.stopBits, parity: this.settings.parity });
    this.open = true;
    this.lost = false;
    this.startReading();
  }

  private startReading(): void {
    const readable = this.port.readable;
    if (!readable) return;
    this.reader = readable.getReader();
    const reader = this.reader;
    this.reading = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) for (const b of value) this.buffer.push(b);
          if (this.buffer.length > 2_000_000) this.buffer.splice(0, this.buffer.length - 2_000_000);
        }
      } catch {
        this.lost = true;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ya liberado
        }
      }
    })();
  }

  async close(): Promise<void> {
    try {
      await this.reader?.cancel();
    } catch {
      // nada
    }
    await this.reading?.catch(() => {});
    this.reader = null;
    this.reading = null;
    try {
      if (this.open) await this.port.close();
    } catch {
      // nada
    }
    this.open = false;
  }

  private async reopen(): Promise<void> {
    await this.close();
    await this.connect();
  }

  async exchange(frame: Uint8Array, options: { timeoutMs: number; quietMs?: number }): Promise<Uint8Array | null> {
    if (!this.open || this.lost) {
      try {
        await this.reopen();
      } catch {
        return null;
      }
    }
    try {
      return await this.once(frame, options);
    } catch {
      // Se cortó a mitad: se reabre una vez. Lo que se mandó puede o no haber llegado; el cliente lo resuelve releyendo.
      try {
        await this.reopen();
      } catch {
        // sigue cortado
      }
      return null;
    }
  }

  private async once(frame: Uint8Array, options: { timeoutMs: number; quietMs?: number }): Promise<Uint8Array | null> {
    const quiet = options.quietMs ?? 60;
    this.buffer = []; // lo viejo que haya quedado no es respuesta a esta orden
    const writer = this.port.writable!.getWriter();
    try {
      await writer.write(frame);
    } finally {
      writer.releaseLock();
    }
    const start = Date.now();
    let lastLen = 0;
    let lastChange = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 10));
      if (this.lost) throw new Error("se desconectó la balanza");
      if (this.buffer.length !== lastLen) {
        lastLen = this.buffer.length;
        lastChange = Date.now();
      }
      if (lastLen > 0 && Date.now() - lastChange >= quiet) break;
      if (lastLen === 0 && Date.now() - start >= options.timeoutMs) return null;
      if (Date.now() - start >= options.timeoutMs + 60_000) break;
    }
    const out = Uint8Array.from(this.buffer);
    this.buffer = [];
    return out;
  }
}

/** Abre el selector de puertos de Chrome (sugiere FTDI, pero deja elegir cualquiera). */
export async function pickSystelPort(): Promise<SerialPort> {
  if (!("serial" in navigator)) throw new Error("Este navegador no permite conectar balanzas por cable. Usá Google Chrome o Microsoft Edge en una computadora.");
  return navigator.serial.requestPort();
}
