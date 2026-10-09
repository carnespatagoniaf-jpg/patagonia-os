import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SystelClient } from "./systel-client";
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
