import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installFakeLocalStorage } from "../scales/test-fake-storage";

/**
 * "Probar todo" (diagnoseScaleLink) contra balanzas simuladas: tiene que
 * distinguir cable/puerto mal (no llega nada) de balanza en otro modo.
 */
type Behavior = "peso" | "datos" | "ruido" | "muda";

class FakeScale {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  lastOptions: SerialOptions | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private behavior: Behavior, private info: SerialPortInfo = { usbVendorId: 0x1a86, usbProductId: 0x7523 }) {}
  getInfo() {
    return this.info;
  }
  async open(options: SerialOptions) {
    this.lastOptions = options;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const send = (bytes: number[] | string) => {
      try {
        controller.enqueue(typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes));
      } catch {
        // cerrado
      }
    };
    if (this.behavior === "ruido") this.timer = setInterval(() => send([0xff, 0x13, 0x88]), 10);
    const behavior = this.behavior;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        // Modo peso: contesta a la "W" solo a 9600 / 2 bits de stop (como la Aura).
        if (behavior === "peso" && chunk[0] === 0x57 && options.baudRate === 9600 && options.stopBits === 2) {
          setTimeout(() => send("2,01.234,\r"), 5);
        }
        // Modo datos: contesta el test de conexión Kretz a 9600 / 2.
        if (behavior === "datos" && chunk[0] === 0x02 && options.baudRate === 9600 && options.stopBits === 2) {
          setTimeout(() => send([0x07, 0x43, 0x30, 0x31, 0x30, 0x30, 0x30, 0x31, 0x37, 0x31, 0x04]), 5);
        }
      }
    });
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.readable = null;
    this.writable = null;
  }
}

installFakeLocalStorage();
let paired: FakeScale[] = [];
const serial = Object.assign(new EventTarget(), { getPorts: async () => paired, requestPort: async () => paired[paired.length - 1] });
Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true });

const fast = { frameTimeoutMs: 15, listenMs: 30 };

describe("Probar todo (diagnóstico de la balanza por cable)", () => {
  it("balanza en modo peso: el cable anda y dice que la pase a Datos para precios", async () => {
    const { diagnoseScaleLink, forgetScalePort } = await import("./scale-serial");
    forgetScalePort();
    paired = [new FakeScale("peso")];
    const d = await diagnoseScaleLink(() => {}, fast);
    assert.equal(d.verdict, "peso");
    assert.equal(d.weightKg, 1.234);
    assert.match(d.message, /COMUNI → MODO = "Datos"/);
    assert.match(d.portLabel, /CH340/);
  });

  it("balanza en modo datos: la encuentra y guarda la configuración", async () => {
    const { diagnoseScaleLink, forgetScalePort, getScaleSerialSettings } = await import("./scale-serial");
    forgetScalePort();
    paired = [new FakeScale("datos")];
    const d = await diagnoseScaleLink(() => {}, fast);
    assert.equal(d.verdict, "datos");
    assert.equal(d.dataSettings?.baudRate, 9600);
    assert.equal(getScaleSerialSettings().stopBits, 2);
  });

  it("llega ruido: el cable transmite pero no entendemos (no lo confunde con una balanza Kretz)", async () => {
    const { diagnoseScaleLink, forgetScalePort } = await import("./scale-serial");
    forgetScalePort();
    paired = [new FakeScale("ruido")];
    const d = await diagnoseScaleLink(() => {}, fast);
    await paired[0].close(); // deja de mandar ruido
    assert.equal(d.verdict, "bytes");
    assert.equal(d.dataSettings, null);
  });

  it("no llega nada: avisa que es físico (puerto, cable directo, driver)", async () => {
    const { diagnoseScaleLink, forgetScalePort } = await import("./scale-serial");
    forgetScalePort();
    paired = [new FakeScale("muda", {})];
    const d = await diagnoseScaleLink(() => {}, fast);
    assert.equal(d.verdict, "nada");
    assert.match(d.message, /DIRECTO/);
    assert.match(d.portLabel, /no es USB/);
  });

  it("'Elegir el puerto' abre siempre el selector, aunque ya haya un puerto con permiso", async () => {
    const { connectScalePort, forgetScalePort, getScalePortDescription } = await import("./scale-serial");
    forgetScalePort();
    const otro = new FakeScale("muda", {});
    const balanza = new FakeScale("peso", { usbVendorId: 0x067b, usbProductId: 0x2303 });
    paired = [otro, balanza]; // requestPort devuelve el último = el que elige la persona
    await connectScalePort();
    assert.match((await getScalePortDescription()) ?? "", /Prolific/);
    // Al recargar la página (sin puerto en memoria) recuerda el elegido, no el primero de la lista.
    forgetScalePort();
    assert.match((await getScalePortDescription()) ?? "", /Prolific/);
  });
});
