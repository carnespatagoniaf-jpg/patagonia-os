// Balanzas simuladas para las pruebas del conector, puestas detrás de un
// FakeByteLink (serie) o de un servidor TCP local (red). Reusan los simuladores de
// la web: FakeAuraDevice (Aura real de Pollo y mar), FakeCuora (documentos de
// Systel). La Report es la de report-sync-e2e.test.ts (que no exporta su clase),
// pasada a bytes: tramas STX…EOT, 2005 guarda el registro de 135 caracteres tal
// cual, 5005 devuelve "el siguiente PLU mayor" como la real.

import net from "node:net";
import { FakeByteLink } from "../../link/fake-byte-link";
import { sameLineSettings, type LineSettings } from "../../link/byte-link";
import { kretzChecksum } from "../../../../web/src/features/inventory/kretz/kretz-frame";
import { FakeAuraDevice } from "../../../../web/src/features/inventory/kretz/aura-fake-device";
import { auraWriteToReadOrder } from "../../../../web/src/features/inventory/kretz/aura-plu";
import { FakeCuora } from "../../../../web/src/features/inventory/systel/systel-fake";

export const AURA_LINE: LineSettings = { baudRate: 9600, dataBits: 8, stopBits: 2, parity: "none" };
export const CUORA_LINE: LineSettings = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none" };
export const CH340 = { usbVendorId: 0x1a86, usbProductId: 0x7523 };
export const FTDI = { usbVendorId: 0x0403, usbProductId: 0x6001 };

/** Kretz Report LT (por red o por cable), a nivel de bytes. */
export class FakeReportDevice {
  readonly records = new Map<number, string>();
  /** PLU de cada 2005 recibido, en orden. */
  readonly writes: number[] = [];
  readonly commands: string[] = [];
  /** Datos de cada 1070 recibido (formato del código de barras de las etiquetas), en orden. */
  readonly barcodeConfigs: string[] = [];
  /** Colgada: recibe pero no contesta. */
  hung = false;
  /** Se llama con cada PLU grabado (para simular cortes a mitad). */
  onWrite: ((plu: number) => void) | null = null;
  private buffer: number[] = [];

  constructor(
    readonly letter = "C",
    readonly id = "01",
  ) {}

  private reply(code: string, data = ""): number[] {
    const body = [0x07, ...Array.from(`${this.letter}${this.id}00${code}${data}`, (c) => c.charCodeAt(0))];
    return [...body, ...kretzChecksum(body), 0x04];
  }

  receive(chunk: Uint8Array | number[]): number[] {
    this.buffer.push(...chunk);
    const out: number[] = [];
    for (;;) {
      const start = this.buffer.indexOf(0x02);
      if (start < 0) {
        this.buffer = [];
        break;
      }
      if (start > 0) this.buffer.splice(0, start);
      const end = this.buffer.indexOf(0x04);
      if (end < 0) break;
      const frame = this.buffer.splice(0, end + 1);
      out.push(...this.handle(frame));
    }
    return this.hung ? [] : out;
  }

  private handle(frame: number[]): number[] {
    const text = String.fromCharCode(...frame.slice(1, frame.length - 3));
    const letter = text[0];
    const id = text.slice(1, 3);
    const command = text.slice(3, 7);
    const data = text.slice(7);
    if (letter !== this.letter || id !== this.id) return [];
    this.commands.push(command);
    if (this.hung) return [];
    if (command === "0001") return this.reply("01");
    if (command === "2005") {
      if (data.length !== 135) return this.reply("10");
      const plu = Number(data.slice(0, 6));
      this.writes.push(plu);
      this.records.set(plu, data);
      this.onWrite?.(plu);
      return this.reply("01");
    }
    if (command === "5005") {
      const after = Number(data);
      const next = [...this.records.keys()].filter((k) => k > after).sort((a, b) => a - b)[0];
      return next === undefined ? this.reply("02") : this.reply("01", this.records.get(next)!);
    }
    if (command === "1070") {
      this.barcodeConfigs.push(data);
      return this.reply("01");
    }
    return this.reply("02");
  }
}

/** Servidor TCP local que se hace pasar por una Report por red (puerto 1001 en la real). */
export async function startReportServer(device: FakeReportDevice): Promise<{ port: number; sockets: Set<net.Socket>; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", (chunk) => {
      const out = device.receive(chunk);
      if (out.length) socket.write(Uint8Array.from(out));
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    sockets,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * FakeAuraDevice guarda el 2005 tal cual llega (sirve para capturar a iTegra). La Aura
 * real lo devuelve en "orden de lectura" (tipo primero, código de 5 + "0"): se aplica
 * la misma transformación comprobada de la web (aura-plu.ts) a lo que se escribe.
 */
export class RealAuraDevice extends FakeAuraDevice {
  /** PLU de cada 2005 recibido, en orden. */
  readonly writes: number[] = [];
  hung = false;
  onWrite: ((plu: number) => void) | null = null;

  override receive(chunk: Uint8Array | number[]): number[] {
    const before = this.log.length;
    const out = super.receive(chunk);
    for (const entry of this.log.slice(before)) {
      if (entry.frame?.command !== "2005" || !entry.frame.checksumOk) continue;
      const data = entry.frame.data;
      this.writes.push(Number(data.slice(0, 6)));
      this.records = this.records.map((r) => (r === data ? auraWriteToReadOrder(data) : r));
      this.onWrite?.(Number(data.slice(0, 6)));
    }
    return this.hung ? [] : out;
  }
}

/** Aura detrás de un puerto serie simulado: contesta solo en 9600 / 8 / 2 bits de stop. */
export function auraLink(device: FakeAuraDevice, label = "COM5"): FakeByteLink {
  return new FakeByteLink({
    label,
    lineSettings: { ...AURA_LINE },
    usbInfo: CH340,
    respond: (written, link) => {
      if (!link.lineSettings || !sameLineSettings(link.lineSettings, AURA_LINE)) return null;
      const out = device.receive(written);
      return out.length ? Uint8Array.from(out) : null;
    },
  });
}

/** Cuora (Systel) detrás de un puerto serie FTDI simulado: contesta solo en 115200 / 8 / 1. */
export function cuoraLink(device: FakeCuora, label = "COM7"): FakeByteLink & { hangCuora: boolean } {
  const link = new FakeByteLink({ label, lineSettings: { ...CUORA_LINE }, usbInfo: FTDI }) as FakeByteLink & { hangCuora: boolean };
  link.hangCuora = false;
  link.respond = (written, l) => {
    if (link.hangCuora || !l.lineSettings || !sameLineSettings(l.lineSettings, CUORA_LINE)) return null;
    void device.exchange(written).then((reply) => {
      if (reply) setTimeout(() => l.inject(reply), 1);
    });
    return null;
  };
  return link;
}

export { FakeCuora };
