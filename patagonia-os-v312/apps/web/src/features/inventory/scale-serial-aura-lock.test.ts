import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installFakeLocalStorage } from "../scales/test-fake-storage";

/** Puerto que anota cada byte que le llega (no debería llegar ninguno). */
class RecordingPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  writes = 0;
  opens = 0;
  async open() {
    this.opens++;
    this.readable = new ReadableStream<Uint8Array>();
    this.writable = new WritableStream<Uint8Array>({ write: () => { this.writes++; } });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

installFakeLocalStorage();
const port = new RecordingPort();
const serial = Object.assign(new EventTarget(), { getPorts: async () => [port] });
Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true });

describe("con la Kretz Aura configurada, las funciones de envío de la Report LT no mandan nada", () => {
  it("enviar uno, enviar todos, borrar y verificar quedan bloqueados aunque el modelo elegido sea Report LT", async () => {
    const s = await import("./scale-serial");
    const { saveModelId } = await import("./kretz/models");
    // Lo que deja guardado "Probar todo" con la Aura real: H01, 9600, 2 bits de stop.
    s.saveScaleSerialSettings({ ...s.getScaleSerialSettings(), deviceType: "H", equipmentId: "01", baudRate: 9600, stopBits: 2 });
    saveModelId("report-lt");
    const product = { id: "x", code: "1", name: "FRUTILLA", priceRetail: 10500, unit: "kg" } as unknown as Parameters<typeof s.syncOneProductToScale>[0];
    await assert.rejects(s.syncOneProductToScale(product), /Bloqueado/);
    await assert.rejects(s.syncProductsToScale([product]), /Bloqueado/);
    await assert.rejects(s.deleteScalePlu("1"), /Bloqueado/);
    await assert.rejects(s.checkScaleCompatibility(), /Bloqueado/);
    // Con el modelo Aura elegido, también.
    s.saveScaleSerialSettings({ ...s.getScaleSerialSettings(), deviceType: "C" });
    saveModelId("aura");
    await assert.rejects(s.deleteScalePlu("1"), /Bloqueado/);
    assert.equal(port.opens, 0);
    assert.equal(port.writes, 0);
  });

  it("con la Report LT (tipo C) no cambia nada: el envío se intenta", async () => {
    const s = await import("./scale-serial");
    const { saveModelId } = await import("./kretz/models");
    saveModelId("report-lt");
    s.saveScaleSerialSettings({ ...s.getScaleSerialSettings(), deviceType: "C", baudRate: 115200, stopBits: 1 });
    assert.doesNotThrow(() => s.assertNotAuraForReportWrites(s.getScaleSerialSettings()));
  });
});
