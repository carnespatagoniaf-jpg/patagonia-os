import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { installFakeLocalStorage } from "../scales/test-fake-storage";
import { forgetWeightScale, readScaleWeight, setWeightScalePort } from "./scale-weight";

/**
 * C20 (plan balanzas v2): Mostrador tomaba el único puerto autorizado aunque fuera el de la Report, y si estaba abierto
 * (la sincronización de productos a 115200) lo CERRABA para abrirlo a 9600. Ahora lee solo del puerto marcado o
 * recordado como balanza de peso, y nunca cierra un puerto que no abrió él.
 */

class FakePort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  opens = 0;
  closes = 0;
  constructor(
    private reply: string | null,
    private info: { usbVendorId?: number; usbProductId?: number } = {}
  ) {}
  getInfo() {
    return this.info;
  }
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
    this.closes++;
    this.readable = null;
    this.writable = null;
  }
}

function paired(ports: FakePort[]) {
  Object.defineProperty(globalThis, "navigator", { value: { serial: { getPorts: async () => ports } }, configurable: true });
}

beforeEach(() => installFakeLocalStorage());
afterEach(async () => {
  await forgetWeightScale();
});

describe("Mostrador y los puertos que tiene abiertos otro módulo (C20)", () => {
  it("un solo puerto autorizado y abierto por la sincronización de la Report: no lo cierra", async () => {
    const report = new FakePort(null, { usbVendorId: 0x1a86, usbProductId: 0x7523 });
    await report.open(); // la sincronización de PLU lo tiene abierto a 115200
    paired([report]);
    await assert.rejects(readScaleWeight());
    assert.equal(report.closes, 0, "no le cortó la conexión a la sincronización");
    assert.equal(report.opens, 1);
    assert.notEqual(report.readable, null);
  });

  it("el puerto marcado como balanza de peso, pero abierto por otro módulo: avisa y no lo cierra", async () => {
    const aura = new FakePort("2,01.000,\r");
    await aura.open();
    paired([aura]);
    await setWeightScalePort(aura as unknown as SerialPort);
    await assert.rejects(readScaleWeight(), /otra parte|otra pestaña/);
    assert.equal(aura.closes, 0);
  });

  it("lee del puerto recordado como balanza de peso, sin probar los otros", async () => {
    const report = new FakePort(null, { usbVendorId: 0x0403, usbProductId: 0x6001 });
    const aura = new FakePort("2,01.500,\r", { usbVendorId: 0x067b, usbProductId: 0x2303 });
    paired([report, aura]);
    localStorage.setItem("patagonia-weight-scale-port", JSON.stringify({ usbVendorId: 0x067b, usbProductId: 0x2303 }));
    const { frame } = await readScaleWeight();
    assert.equal(frame.weightKg, 1.5);
    assert.equal(report.opens, 0, "no le mandó nada a la Report");
  });

  it("el que respondió como balanza de peso queda recordado", async () => {
    const mute = new FakePort(null, { usbVendorId: 0x0403, usbProductId: 0x6001 });
    const aura = new FakePort("2,02.000,\r", { usbVendorId: 0x067b, usbProductId: 0x2303 });
    paired([mute, aura]);
    await readScaleWeight();
    assert.deepEqual(JSON.parse(localStorage.getItem("patagonia-weight-scale-port") ?? "null"), { usbVendorId: 0x067b, usbProductId: 0x2303 });
  });

  it("solo cierra al quedar sin uso el puerto que abrió él", async () => {
    const aura = new FakePort("2,01.000,\r");
    paired([aura]);
    await readScaleWeight();
    await forgetWeightScale();
    assert.equal(aura.closes, 1);
    const other = new FakePort("2,01.000,\r");
    await other.open();
    paired([other]);
    await setWeightScalePort(other as unknown as SerialPort);
    await forgetWeightScale();
    assert.equal(other.closes, 0, "olvidarlo no cierra un puerto ajeno");
  });
});
