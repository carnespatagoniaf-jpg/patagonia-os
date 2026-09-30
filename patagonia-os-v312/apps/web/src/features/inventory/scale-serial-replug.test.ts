import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installFakeLocalStorage } from "../scales/test-fake-storage";

/** Puerto serie simulado: cuenta lo que le mandan y contesta algo corto (con EOT) a cada envío. */
class FakePort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  writes = 0;
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    this.writable = new WritableStream<Uint8Array>({
      write: () => {
        this.writes++;
        controller.enqueue(new Uint8Array([0x41, 0x04]));
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

// `navigator.serial` tiene que existir ANTES de cargar el módulo, que es
// cuando se engancha al evento "disconnect".
installFakeLocalStorage();
let paired: FakePort[] = [];
const serial = Object.assign(new EventTarget(), { getPorts: async () => paired });
Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true });

function unplug(port: FakePort) {
  paired = paired.filter((p) => p !== port);
  const event = new Event("disconnect");
  // En Chrome el evento sale del puerto y sube hasta navigator.serial (target = el puerto).
  Object.defineProperty(event, "target", { value: port });
  serial.dispatchEvent(event);
}

describe("scale-serial — desenchufar y volver a enchufar sin recargar la página", () => {
  it("después de desenchufar, el próximo envío va al puerto nuevo", async () => {
    const { sendScalePing } = await import("./scale-serial");
    const before = new FakePort();
    paired = [before];
    await sendScalePing();
    assert.equal(before.writes, 1);

    unplug(before);
    const after = new FakePort();
    paired = [after];
    await sendScalePing();
    assert.equal(after.writes, 1);
    assert.equal(before.writes, 1, "no se le manda nada al puerto viejo");
  });
});
