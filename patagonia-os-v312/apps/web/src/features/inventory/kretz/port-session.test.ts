import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DISCOVERY_OPEN_BUDGET, runKretzDiscovery, scanAllPlus } from "./discovery";
import { kretzChecksum } from "./kretz-frame";
import { getKretzModel } from "./models";
import { classifyOpenError, freshPortFor, newSession, openForSession } from "./port-session";

const aura = getKretzModel("aura");
const fast = { releaseOtherTabs: false, frameTimeoutMs: 30 } as const;

function kretzReply(group: string, code: string, data = ""): number[] {
  const body = [0x07, ...Array.from("H01" + group + code + data, (c) => c.charCodeAt(0))];
  return [...body, ...kretzChecksum(body), 0x04];
}

const windowsRejects = () => Object.assign(new Error("Failed to execute 'open' on 'SerialPort': Failed to open serial port."), { name: "NetworkError" });

/**
 * Aura simulada (H01, 9600/2) que imita a Chrome: abrir un puerto ya abierto
 * tira InvalidStateError, y cuenta cuántas aperturas hubo y cuántas a la vez.
 * `failOpens` = cuántas aperturas seguidas rechaza Windows antes de dejar abrir.
 */
class FakeAura {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  connected?: boolean;
  opens = 0;
  failOpens = 0;
  failWith: () => Error = windowsRejects;
  breakWrites = false;
  info = { usbVendorId: 0x1a86, usbProductId: 0x7523 };
  getInfo() {
    return this.info;
  }
  async open(options: SerialOptions) {
    this.opens++;
    if (this.readable) throw Object.assign(new Error("The port is already open."), { name: "InvalidStateError" });
    if (this.failOpens > 0) {
      this.failOpens--;
      throw this.failWith();
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const self = this;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (self.breakWrites) throw new Error("Framing error");
        if (chunk[0] !== 0x02 || options.baudRate !== 9600 || options.stopBits !== 2) return;
        const command = String.fromCharCode(...chunk.slice(4, 8));
        setTimeout(() => {
          try {
            controller.enqueue(new Uint8Array(kretzReply(command === "0001" ? "00" : "05", command === "5005" ? "20" : "01")));
          } catch {
            // cerrado
          }
        }, 2);
      }
    });
  }
  async close() {
    if (this.readable?.locked || this.writable?.locked) throw Object.assign(new Error("locked"), { name: "TypeError" });
    this.readable = null;
    this.writable = null;
  }
}

describe("apertura del puerto de la Aura (port-session)", () => {
  it("clasifica el error de Chrome en vez de decir siempre 'no se pudo abrir'", () => {
    assert.equal(classifyOpenError(windowsRejects()).kind, "windows_rechazo");
    assert.equal(classifyOpenError(Object.assign(new Error("The port is already open."), { name: "InvalidStateError" })).kind, "ya_abierto_en_esta_pestana");
    assert.equal(classifyOpenError(Object.assign(new Error("x"), { name: "NotFoundError" })).kind, "desconectado");
    assert.equal(classifyOpenError(windowsRejects(), false).kind, "desconectado");
    assert.equal(classifyOpenError(Object.assign(new Error("x"), { name: "SecurityError" })).kind, "sin_permiso");
  });

  it("Windows rechaza siempre: la prueba se corta dentro del presupuesto (antes llegaba a 700 aperturas) y dice el motivo", async () => {
    const port = new FakeAura();
    port.failOpens = Infinity;
    const record = await runKretzDiscovery(port as unknown as SerialPort, "prueba", aura, fast);
    assert.equal(record.verdict, "puerto");
    assert.ok(port.opens <= DISCOVERY_OPEN_BUDGET, `abrió ${port.opens} veces`);
    assert.equal(record.openLog!.filter((o) => o.settings.includes("destrabar")).length <= 2, true, "destrabar: una sola ronda");
    assert.ok(record.openLog!.every((o) => o.ok || o.kind), "cada falla queda clasificada");
    assert.match(record.stages![1].detail, /Windows rechazó abrir el puerto/);
    assert.match(record.stages![1].detail, /NetworkError: Failed to execute 'open'/);
  });

  it("se recupera sola si Windows rechaza la primera apertura (sin recargar la página)", async () => {
    const port = new FakeAura();
    port.failOpens = 1;
    const record = await runKretzDiscovery(port as unknown as SerialPort, "prueba", aura, fast);
    assert.equal(record.verdict, "datos");
    assert.equal(port.readable, null, "al terminar el puerto queda cerrado");
  });

  it("desenchufado: no reintenta a ciegas, lo dice", async () => {
    const port = new FakeAura();
    port.failOpens = Infinity;
    port.failWith = () => Object.assign(new Error("The device has been lost."), { name: "NotFoundError" });
    const record = await runKretzDiscovery(port as unknown as SerialPort, "prueba", aura, fast);
    assert.equal(record.verdict, "puerto");
    assert.equal(port.opens, 1);
    assert.match(record.stages![1].detail, /no está conectado/);
  });

  it("dos pruebas a la vez sobre el mismo puerto: la segunda no lo abre otra vez y la primera termina bien", async () => {
    const port = new FakeAura();
    const [a, b] = await Promise.all([
      runKretzDiscovery(port as unknown as SerialPort, "prueba", aura, fast),
      runKretzDiscovery(port as unknown as SerialPort, "prueba", aura, fast)
    ]);
    assert.equal(a.verdict, "datos");
    assert.equal(b.verdict, "puerto");
    assert.match(b.stages![1].detail, /ya hay una prueba en curso/);
    assert.ok(!a.openLog!.some((o) => o.kind === "ya_abierto_en_esta_pestana"));
    // Liberado al terminar: una tercera prueba anda.
    assert.equal((await runKretzDiscovery(port as unknown as SerialPort, "prueba", aura, fast)).verdict, "datos");
  });

  it("si el cable falla en medio de la lectura, el puerto queda cerrado y liberado, y la próxima lectura anda", async () => {
    const port = new FakeAura();
    port.breakWrites = true;
    const responder = { link: { baudRate: 9600, stopBits: 2 as const }, deviceType: "H", equipmentId: "01" };
    const broken = await scanAllPlus(port as unknown as SerialPort, responder, "aura", { timeoutMs: 30 });
    assert.equal(broken.stoppedBy, "error");
    assert.equal(port.readable, null);
    port.breakWrites = false;
    const ok = await scanAllPlus(port as unknown as SerialPort, responder, "aura", { timeoutMs: 30 });
    assert.equal(ok.stoppedBy, "fin");
  });

  it("si el cable falla al mandar la primera instrucción, igual devuelve el registro (llega a soporte) y suelta el puerto", async () => {
    const port = new FakeAura();
    port.breakWrites = true;
    const record = await runKretzDiscovery(port as unknown as SerialPort, "prueba", aura, fast);
    assert.equal(record.verdict, "nada");
    assert.equal(record.stages![1].status, "ok");
    assert.equal(record.stages![2].status, "falla");
    assert.match(record.stages![2].detail, /Framing error/);
    assert.equal(port.readable, null);
    port.breakWrites = false;
    assert.equal((await runKretzDiscovery(port as unknown as SerialPort, "prueba", aura, fast)).verdict, "datos");
  });

  it("si quedó abierto en esta pestaña, lo cierra antes de abrir (no da InvalidStateError)", async () => {
    const port = new FakeAura();
    await port.open({ baudRate: 9600, stopBits: 2 });
    const session = newSession(4);
    await openForSession(port as unknown as SerialPort, { baudRate: 9600, stopBits: 2 }, session);
    assert.deepEqual(session.log.map((o) => o.ok), [true]);
    await port.close();
  });

  it("puerto viejo tras desenchufar y volver a enchufar: usa el nuevo del mismo aparato USB", async () => {
    const old = new FakeAura();
    old.connected = false;
    const replugged = new FakeAura();
    replugged.connected = true;
    const other = new FakeAura();
    other.info = { usbVendorId: 0x0403, usbProductId: 0x6001 };
    Object.defineProperty(globalThis, "navigator", { value: { serial: { getPorts: async () => [other, old, replugged] } }, configurable: true });
    try {
      assert.equal(await freshPortFor(old as unknown as SerialPort), replugged);
      const record = await runKretzDiscovery(old as unknown as SerialPort, "prueba", aura, fast);
      assert.equal(record.verdict, "datos");
      assert.equal(old.opens, 0);
      assert.match(record.stages![0].detail, /se había reconectado/);
    } finally {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  });
});

/** Report LT / NX simulada: contesta solo con su letra "C", SU número de equipo y su velocidad. */
class FakeReport {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  opens = 0;
  constructor(private equipment: string, private baud: number, private stop: 1 | 2 = 1) {}
  getInfo() {
    return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
  }
  async open(options: SerialOptions) {
    this.opens++;
    if (this.readable) throw Object.assign(new Error("The port is already open."), { name: "InvalidStateError" });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const self = this;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (chunk[0] !== 0x02 || options.baudRate !== self.baud || (options.stopBits ?? 1) !== self.stop) return;
        const head = String.fromCharCode(...chunk.slice(1, 4));
        if (head !== "C" + self.equipment) return; // otra letra u otro número: no contesta
        const body = [0x07, ...Array.from(`C${self.equipment}0001`, (c) => c.charCodeAt(0))];
        setTimeout(() => {
          try {
            controller.enqueue(new Uint8Array([...body, ...kretzChecksum(body), 0x04]));
          } catch {
            // cerrado
          }
        }, 2);
      }
    });
  }
  async close() {
    if (this.readable?.locked || this.writable?.locked) throw Object.assign(new Error("locked"), { name: "TypeError" });
    this.readable = null;
    this.writable = null;
  }
}

describe("Report NX con otro número de balanza", () => {
  const report = getKretzModel("report-lt");
  const quick = { releaseOtherTabs: false, frameTimeoutMs: 15, listenMs: 20 } as const;

  it("la Report de siempre (C01, 115200) se encuentra al toque", async () => {
    const port = new FakeReport("01", 115200);
    const record = await runKretzDiscovery(port as unknown as SerialPort, "prueba", report, quick);
    assert.equal(record.verdict, "datos");
    assert.equal(record.responder?.equipmentId, "01");
  });

  it("una NX configurada como balanza 09 aparece buscando el número (antes: 'no contestó ni un byte')", async () => {
    const port = new FakeReport("09", 115200);
    const record = await runKretzDiscovery(port as unknown as SerialPort, "prueba", report, quick);
    assert.equal(record.verdict, "datos");
    assert.deepEqual(record.responder, { link: { baudRate: 115200, stopBits: 1 }, deviceType: "C", equipmentId: "09" });
    assert.ok(port.opens <= DISCOVERY_OPEN_BUDGET, `abrió ${port.opens} veces`);
    assert.ok(record.exchanges.length < 80, "los intentos sin respuesta no inflan el reporte");
  });

  it("también a 9600 baudios (balanza 05)", async () => {
    const port = new FakeReport("05", 9600);
    const record = await runKretzDiscovery(port as unknown as SerialPort, "prueba", report, quick);
    assert.equal(record.responder?.equipmentId, "05");
    assert.equal(record.responder?.link.baudRate, 9600);
  });

  it("Report por adaptador USB a serie (CH340): activa DTR y RTS al abrir; una Report sin USB (Bluetooth) no", async () => {
    const withAdapter = Object.assign(new FakeReport("01", 115200), { signals: [] as unknown[], setSignals(this: { signals: unknown[] }, x: unknown) { this.signals.push(x); return Promise.resolve(); } });
    await runKretzDiscovery(withAdapter as unknown as SerialPort, "prueba", report, quick);
    assert.ok(withAdapter.signals.length > 0, "con CH340 activa las señales");
    assert.deepEqual(withAdapter.signals[0], { dataTerminalReady: true, requestToSend: true });
    const bluetooth = Object.assign(new FakeReport("01", 115200), { getInfo: () => ({}), signals: [] as unknown[], setSignals(this: { signals: unknown[] }, x: unknown) { this.signals.push(x); return Promise.resolve(); } });
    const r = await runKretzDiscovery(bluetooth as unknown as SerialPort, "prueba", report, quick);
    assert.equal(r.verdict, "datos", "la Report por Bluetooth sigue andando igual");
    assert.equal(bluetooth.signals.length, 0, "sin USB no se tocan las señales");
  });

  it("si no contesta ningún número, dice que se buscó y deja el puerto cerrado", async () => {
    const port = new FakeReport("07", 38400);
    const record = await runKretzDiscovery(port as unknown as SerialPort, "prueba", report, quick);
    assert.equal(record.verdict, "nada");
    assert.ok(record.exchanges.some((e) => e.step === "buscando el número de balanza"));
    assert.equal(port.readable, null);
    assert.ok(port.opens <= DISCOVERY_OPEN_BUDGET, `abrió ${port.opens} veces`);
  });
});
