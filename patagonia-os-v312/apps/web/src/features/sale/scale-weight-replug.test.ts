import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Puerto serie simulado que contesta `reply` cuando le piden el peso ("W"). */
class FakePort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  constructor(private reply: string) {}
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const reply = this.reply;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (chunk[0] === 0x57) controller.enqueue(new TextEncoder().encode(reply));
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

describe("scale-weight — desenchufar y volver a enchufar sin recargar la página", () => {
  it("después de desenchufar, la próxima lectura toma el puerto nuevo", async () => {
    const { readScaleWeight } = await import("./scale-weight");
    const before = new FakePort("2,01.000,\r");
    paired = [before];
    assert.equal((await readScaleWeight()).frame.weightKg, 1);

    unplug(before);
    const after = new FakePort("2,02.000,\r");
    paired = [after];
    assert.equal((await readScaleWeight()).frame.weightKg, 2);
  });
});
