import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SystelExchangeLog } from "./systel-client";
import { discoverSystelLink } from "./systel-discovery";
import { FakeCuora } from "./systel-fake";
import type { SystelSerialSettings } from "./systel-serial";

/** Puerto serie de mentira: la Cuora simulada contesta solo si la configuración del puerto es la suya. */
class FakeSerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  opened: SystelSerialSettings[] = [];
  signals = 0;
  constructor(private cuora: FakeCuora, private wants: SystelSerialSettings) {}
  async open(o: { baudRate: number; stopBits?: number; parity?: string }) {
    const settings = { baudRate: o.baudRate, stopBits: (o.stopBits ?? 1) as 1 | 2, parity: (o.parity ?? "none") as SystelSerialSettings["parity"] };
    this.opened.push(settings);
    const match = settings.baudRate === this.wants.baudRate && settings.stopBits === this.wants.stopBits && settings.parity === this.wants.parity;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const cuora = this.cuora;
    this.writable = new WritableStream<Uint8Array>({
      async write(frame) {
        if (!match) return; // configuración equivocada: la balanza no contesta nada
        const reply = await cuora.exchange(frame);
        if (reply) setTimeout(() => controller.enqueue(reply), 2);
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
  async setSignals() {
    this.signals += 1;
  }
}

describe("buscar cómo habla la balanza (solo lectura)", () => {
  it("encuentra una Cuora con paridad par y número 7, mandando solo pings", async () => {
    const cuora = new FakeCuora("max62", { address: 7 });
    const port = new FakeSerialPort(cuora, { baudRate: 115200, stopBits: 1, parity: "even" });
    const log: SystelExchangeLog[] = [];
    const found = await discoverSystelLink(port as unknown as SerialPort, log);
    assert.ok(found, "la tiene que encontrar");
    assert.equal(found!.address, 7);
    assert.deepEqual(found!.settings, { baudRate: 115200, stopBits: 1, parity: "even" });
    assert.ok(log.every((l) => l.fn === 23), "solo se manda la función 23 (ping, lectura)");
    assert.ok(port.signals > 0, "enciende las señales del cable");
    await found!.link.close();
  });

  it("con el 0 (dirección general) toma el número que contesta la balanza", async () => {
    const cuora = new FakeCuora("max62", { address: 42 });
    const port = new FakeSerialPort(cuora, { baudRate: 115200, stopBits: 1, parity: "none" });
    const found = await discoverSystelLink(port as unknown as SerialPort, []);
    assert.equal(found?.address, 42);
    await found?.link.close();
  });

  it("si nada contesta, devuelve null y deja todo anotado", async () => {
    const cuora = new FakeCuora("max62", { address: 1 });
    const port = new FakeSerialPort(cuora, { baudRate: 4800, stopBits: 1, parity: "none" });
    const log: SystelExchangeLog[] = [];
    const found = await discoverSystelLink(port as unknown as SerialPort, log, () => {}, null, 15);
    assert.equal(found, null);
    assert.ok(log.length > 100, "probó muchas combinaciones");
    assert.ok(log.every((l) => l.result === "sin respuesta"));
  });
});
