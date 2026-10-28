import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SystelClient } from "./systel-client";
import { FakeCuora } from "./systel-fake";
import { SerialSystelLink } from "./systel-serial";

/** Arma una respuesta Systel: dirección + función + datos + XOR de todo lo anterior. */
function reply(address: number, fn: number, data: string): Uint8Array {
  const bytes = [address, fn, ...Array.from(data, (ch) => ch.charCodeAt(0))];
  return Uint8Array.from([...bytes, bytes.reduce((x, b) => x ^ b, 0)]);
}

/** Puerto de mentira que contesta la lista en dos partes, con una pausa en el medio (como la balanza real de Los gringos). */
class PausingPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  constructor(private answer: Uint8Array, private pauseMs: number) {}
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const { answer, pauseMs } = this;
    this.writable = new WritableStream<Uint8Array>({
      write() {
        const cut = Math.floor(answer.length / 2);
        setTimeout(() => controller.enqueue(answer.slice(0, cut)), 2);
        setTimeout(() => controller.enqueue(answer.slice(cut)), 2 + pauseMs);
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

describe("respuesta larga con una pausa en el medio", () => {
  it("no corta la lista de PLU en la pausa: espera hasta que la verificación cierre", async () => {
    const data = Array.from({ length: 900 }, (_, i) => `N${String(i + 1).padStart(4, "0")}V0`).join("") + "F";
    const port = new PausingPort(reply(20, 31, data), 300);
    const link = new SerialSystelLink(port as unknown as SerialPort);
    await link.connect();
    const client = new SystelClient(link, { address: 20 });
    const list = await client.list();
    await link.close();
    assert.ok(list, "la lista se tiene que leer entera");
    assert.equal(list!.entries.length, 900);
  });
});

describe("balanza ocupada (E3)", () => {
  it("una lectura que recibe E3 se reintenta sola y sale bien", async () => {
    const cuora = new FakeCuora("max62", { address: 20 });
    cuora.busyReplies = 3;
    const client = new SystelClient(cuora, { address: 20, busyRetryMs: [5, 5, 5, 5, 5] });
    const sig = await client.signature();
    assert.ok(sig, "después de los E3 tiene que leer la firma");
  });

  it("con un solo E3 repite la secuencia de arranque (ping al 1 y general) y pide una vez más, solo con pings", async () => {
    const cuora = new FakeCuora("max62", { address: 20 });
    const client = new SystelClient(cuora, { address: 20, busyRetryMs: [5, 5, 5] });
    cuora.busyReplies = 1;
    const before = cuora.received.length;
    assert.ok(await client.ping());
    const sent = cuora.received.slice(before);
    assert.equal(sent.length, 4, "E3, ping al 1, ping general, reintento");
    assert.ok(sent.every((r) => r.fn === 23));
  });
});

/** Puerto que se "desenchufa" (el stream de lectura da error) después de la primera respuesta. */
class UnpluggingPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  opens = 0;
  writes = 0;
  async open() {
    this.opens += 1;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const self = this;
    this.writable = new WritableStream<Uint8Array>({
      write(frame) {
        self.writes += 1;
        const answer = reply(frame[0], frame[1], "00T");
        setTimeout(() => controller.enqueue(answer), 2);
        if (self.opens === 1) setTimeout(() => controller.error(new Error("device lost")), 120);
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

describe("desconexión del cable", () => {
  it("si el cable se corta, la próxima orden reabre el puerto una vez y sigue", async () => {
    const port = new UnpluggingPort();
    const link = new SerialSystelLink(port as unknown as SerialPort);
    await link.connect();
    const client = new SystelClient(link, { address: 20 });
    assert.ok(await client.ping());
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(await client.ping(), "después de reabrir contesta");
    assert.equal(port.opens, 2);
    await link.close();
  });
});

/**
 * Como un puerto real de Chrome: abrirlo dos veces da "The port is already open". `failNextClose` simula un cierre
 * que no termina (el puerto sigue abierto), lo que dejó a Giuseppe (27 y 28/10) sin leer 54 a 80 productos.
 */
class StrictPort {
  private stream: ReadableStream<Uint8Array> | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private isOpen = false;
  writable: WritableStream<Uint8Array> | null = null;
  failNextClose = false;
  opens = 0;
  /** Como Chrome: con el puerto abierto, si la lectura anterior se canceló, da una nueva. */
  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.isOpen) return null;
    if (!this.stream) {
      this.stream = new ReadableStream<Uint8Array>({
        start: (c) => { this.controller = c; },
        cancel: () => { this.stream = null; this.controller = null; }
      });
    }
    return this.stream;
  }
  async open() {
    if (this.isOpen) throw new Error("Failed to execute 'open' on 'SerialPort': The port is already open.");
    this.opens += 1;
    this.isOpen = true;
    this.writable = new WritableStream<Uint8Array>({
      write: () => {
        setTimeout(() => this.controller?.enqueue(reply(20, 23, "00D")), 2);
      }
    });
  }
  async close() {
    if (this.failNextClose) {
      this.failNextClose = false;
      throw new Error("Failed to execute 'close' on 'SerialPort': the port is busy");
    }
    this.isOpen = false;
    this.stream = null;
    this.writable = null;
  }
}

describe("conexión cortada a mitad de la lectura (real Giuseppe 27-28/10)", () => {
  it("si el cierre no terminó y el puerto sigue abierto, se vuelve a usar en vez de fallar con 'already open'", async () => {
    const port = new StrictPort();
    const link = new SerialSystelLink(port as unknown as SerialPort);
    await link.connect();
    const client = new SystelClient(link, { address: 20 });
    assert.ok(await client.ping(), "primera lectura");
    port.failNextClose = true;
    await link.close(); // algo de afuera cierra la conexión y el puerto queda abierto
    assert.ok(await client.ping(), "después del corte sigue leyendo");
    assert.ok(await client.ping());
    assert.ok(link.events.some((e) => e.kind === "abrir" && /se vuelve a usar/.test(e.detail)));
    assert.ok(link.events.some((e) => e.kind === "cerrar" && e.detail.length > 0), "anota quién cerró");
    await link.close();
  });
});
