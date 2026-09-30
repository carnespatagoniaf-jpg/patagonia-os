import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { forgetWeightScale, readScaleWeight, setWeightScalePort } from "./scale-weight";

/** Puerto serie simulado: si `reply` no es null, contesta eso cuando le piden el peso ("W"). */
class FakePort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  opens = 0;
  constructor(private reply: string | null) {}
  async open() {
    this.opens++;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const reply = this.reply;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (reply && chunk[0] === 0x57) controller.enqueue(new TextEncoder().encode(reply));
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

function pairedPorts(ports: FakePort[]) {
  Object.defineProperty(globalThis, "navigator", {
    value: { serial: { getPorts: async () => ports } },
    configurable: true
  });
}

afterEach(async () => {
  await forgetWeightScale();
});

describe("scale-weight — con varios aparatos conectados", () => {
  it("elige el que responde como balanza de peso, no el primero de la lista", async () => {
    const mute = new FakePort(null);
    const aura = new FakePort("2,01.250,\r");
    pairedPorts([mute, aura]);
    const { frame } = await readScaleWeight();
    assert.equal(frame.weightKg, 1.25);
    assert.equal(mute.readable, null, "el puerto que no respondió queda cerrado");
  });

  it("no toca un puerto que ya tiene abierto otra parte de la app", async () => {
    const report = new FakePort(null);
    await report.open();
    const aura = new FakePort("2,02.500,\r");
    pairedPorts([report, aura]);
    const { frame } = await readScaleWeight();
    assert.equal(frame.weightKg, 2.5);
    assert.equal(report.opens, 1);
    assert.notEqual(report.readable, null);
  });

  it("si ninguno responde, avisa en vez de inventar un peso", async () => {
    pairedPorts([new FakePort(null), new FakePort(null)]);
    await assert.rejects(readScaleWeight(), /ninguno respondió como balanza de peso/);
  });

  it("usa el puerto que le pasa la pantalla Balanzas", async () => {
    const other = new FakePort("2,09.999,\r");
    const chosen = new FakePort("2,03.750,\r");
    pairedPorts([other]);
    await setWeightScalePort(chosen as unknown as SerialPort);
    const { frame } = await readScaleWeight();
    assert.equal(frame.weightKg, 3.75);
    assert.equal(other.opens, 0);
  });
});
