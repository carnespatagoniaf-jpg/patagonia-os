import type { SystelExchangeOptions, SystelLink } from "./systel-client";

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

/** Cuánto se espera en silencio cuando la respuesta todavía no cerró bien. */
export const INCOMPLETE_QUIET_MS = 2000;

export const CUORA_SERIAL: SystelSerialSettings = { baudRate: 115200, stopBits: 1, parity: "none" };

/**
 * Lo que pasó en el cable, con milisegundos desde que se creó la conexión. Se manda a soporte.
 * Agregado 2026-10-09: los registros de Los gringos no tenían cuándo se abrió el puerto, cuánto
 * pasó hasta la primera orden, qué bytes se descartaron ni cuándo llegó cada byte.
 */
export interface SystelLinkEvent {
  t: number;
  kind: "abrir" | "señales" | "descartado" | "tx" | "rx" | "lectura cortada" | "cerrar" | "error al abrir";
  detail: string;
  hex?: string;
}

const MAX_EVENTS = 3000;
const hexOf = (bytes: ArrayLike<number>, max = 400) => {
  const all = Array.from(bytes as ArrayLike<number>, (b) => b.toString(16).padStart(2, "0"));
  return all.length > max ? `${all.slice(0, max).join(" ")} … (+${all.length - max} bytes)` : all.join(" ");
};

export class SerialSystelLink implements SystelLink {
  private readonly born = Date.now();
  private buffer: number[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private reading: Promise<void> | null = null;
  private open = false;
  private lost = false;

  /** `events` se puede compartir entre varias conexiones (la búsqueda abre una por configuración). */
  constructor(private port: SerialPort, private readonly settings: SystelSerialSettings = CUORA_SERIAL, readonly events: SystelLinkEvent[] = []) {}

  private note(kind: SystelLinkEvent["kind"], detail: string, hex?: string): void {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push({ t: Date.now() - this.born, kind, detail, ...(hex !== undefined ? { hex } : {}) });
  }

  async connect(): Promise<void> {
    if (this.open) return;
    const s = this.settings;
    const label = `${s.baudRate} ${s.parity} ${s.stopBits} stop`;
    try {
      await this.port.open({ baudRate: s.baudRate, dataBits: 8, stopBits: s.stopBits, parity: s.parity });
    } catch (err) {
      this.note("error al abrir", `${label}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    let info = "";
    try {
      const i = this.port.getInfo?.();
      if (i) info = ` · USB ${(i.usbVendorId ?? 0).toString(16).padStart(4, "0")}:${(i.usbProductId ?? 0).toString(16).padStart(4, "0")}`;
    } catch {
      // sin datos del puerto
    }
    this.note("abrir", label + info);
    this.open = true;
    this.lost = false;
    this.startReading();
  }

  /** DTR y RTS encendidos: algunos cables/adaptadores no pasan datos sin esas señales. Si el puerto no lo permite, se sigue igual. */
  async setSignals(on: boolean): Promise<void> {
    try {
      const port = this.port as SerialPort & { setSignals?: (signals: { dataTerminalReady?: boolean; requestToSend?: boolean }) => Promise<void> };
      await port.setSignals?.({ dataTerminalReady: on, requestToSend: on });
      this.note("señales", `DTR y RTS ${on ? "encendidas" : "apagadas"}`);
    } catch (err) {
      this.note("señales", `no se pudieron cambiar: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      } catch (err) {
        this.lost = true;
        this.note("lectura cortada", err instanceof Error ? err.message : String(err));
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
    if (this.buffer.length) this.note("descartado", `${this.buffer.length} bytes sin leer al cerrar`, hexOf(this.buffer));
    try {
      if (this.open) await this.port.close();
    } catch {
      // nada
    }
    if (this.open) this.note("cerrar", "");
    this.open = false;
  }

  private async reopen(): Promise<void> {
    await this.close();
    await this.connect();
  }

  /** Una orden por vez en el cable: si se piden dos juntas, la segunda espera a que termine la primera. */
  private queue: Promise<unknown> = Promise.resolve();

  exchange(frame: Uint8Array, options: SystelExchangeOptions): Promise<Uint8Array | null> {
    const run = this.queue.then(() => this.exchangeNow(frame, options));
    this.queue = run.catch(() => {});
    return run;
  }

  private async exchangeNow(frame: Uint8Array, options: SystelExchangeOptions): Promise<Uint8Array | null> {
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

  private async once(frame: Uint8Array, options: SystelExchangeOptions): Promise<Uint8Array | null> {
    const quiet = options.quietMs ?? 60;
    // Lo que haya quedado no es respuesta a esta orden; se descarta, pero queda anotado.
    if (this.buffer.length) this.note("descartado", `${this.buffer.length} bytes llegaron sin pedirlos`, hexOf(this.buffer));
    this.buffer = [];
    const writer = this.port.writable!.getWriter();
    try {
      await writer.write(frame);
    } finally {
      writer.releaseLock();
    }
    this.note("tx", `${frame.length} bytes`, hexOf(frame));
    const start = Date.now();
    let lastLen = 0;
    let lastChange = Date.now();
    let firstAt = -1;
    let pauses = 0;
    let end = "silencio";
    for (;;) {
      await new Promise((r) => setTimeout(r, 10));
      if (this.lost) throw new Error("se desconectó la balanza");
      if (this.buffer.length !== lastLen) {
        if (lastLen === 0) firstAt = Date.now() - start;
        else if (Date.now() - lastChange >= quiet) pauses += 1;
        lastLen = this.buffer.length;
        lastChange = Date.now();
      }
      if (lastLen > 0 && Date.now() - lastChange >= quiet) {
        // Pausa a mitad de una respuesta: se sigue esperando en silencio hasta el plazo de esa orden
        // (la lista de PLU tiene 15 s). Real: la Cuora hace una pausa antes de la "F" final de la lista.
        const incomplete = options.isComplete && !options.isComplete(Uint8Array.from(this.buffer));
        if (!incomplete) break;
        if (Date.now() - lastChange >= Math.max(INCOMPLETE_QUIET_MS, options.timeoutMs)) {
          end = "incompleta: se agotó la espera";
          break;
        }
      }
      if (lastLen === 0 && Date.now() - start >= options.timeoutMs) {
        this.note("rx", `nada en ${options.timeoutMs} ms`);
        return null;
      }
      if (Date.now() - start >= options.timeoutMs + 60_000) {
        end = "plazo máximo";
        break;
      }
    }
    const out = Uint8Array.from(this.buffer);
    this.buffer = [];
    this.note("rx", `${out.length} bytes · primer byte a los ${firstAt} ms · último a los ${lastChange - start} ms · ${pauses} pausas · fin: ${end}`, hexOf(out, 64));
    return out;
  }
}

/** Abre el selector de puertos de Chrome (sugiere FTDI, pero deja elegir cualquiera). */
export async function pickSystelPort(): Promise<SerialPort> {
  if (!("serial" in navigator)) throw new Error("Este navegador no permite conectar balanzas por cable. Usá Google Chrome o Microsoft Edge en una computadora.");
  // REAL (Los gringos 14/10): después de un cuadro de confirmación Chrome ya no muestra la lista de puertos (requestPort
  // necesita un clic directo). Si ya hay un solo puerto autorizado de la balanza (FTDI), se usa ése sin preguntar.
  const granted = await navigator.serial.getPorts();
  const ftdi = granted.filter((p) => p.getInfo().usbVendorId === 0x0403);
  if (ftdi.length === 1) return ftdi[0];
  if (granted.length === 1) return granted[0];
  return navigator.serial.requestPort();
}
