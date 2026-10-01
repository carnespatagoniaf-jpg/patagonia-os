import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertReadOnly, isReadOnlyCommand, runKretzDiscovery, scanAllPlus } from "./discovery";
import { buildKretzFrame, kretzChecksum } from "./kretz-frame";
import { getKretzModel } from "./models";

/** Respuesta Kretz bien armada (0x07 + tipo + ID + grupo + código + datos + checksum + EOT). */
function kretzReply(letter: string, id: string, group: string, code: string, data = ""): number[] {
  const body = [0x07, ...Array.from(letter + id + group + code + data, (c) => c.charCodeAt(0))];
  return [...body, ...kretzChecksum(body), 0x04];
}

/** Aura simulada que habla trama Kretz SOLO con una letra e ID puntuales, a 9600/2. Anota todo lo que recibe. */
class FakeKretzScale {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  received: Uint8Array[] = [];
  constructor(private letter: string, private id: string) {}
  async open(options: SerialOptions) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const self = this;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        self.received.push(chunk);
        if (chunk[0] !== 0x02 || options.baudRate !== 9600 || options.stopBits !== 2) return;
        const text = String.fromCharCode(...chunk.slice(1, 8));
        const letter = text[0], id = text.slice(1, 3), command = text.slice(3, 7);
        if (letter !== self.letter || id !== self.id) return; // otra letra/ID: no contesta
        const data = command === "5002" ? "016003" : command === "5005" ? "000001ASADO" : "";
        setTimeout(() => {
          try {
            controller.enqueue(new Uint8Array(kretzReply(letter, id, "05", "01", data)));
          } catch {
            // cerrado
          }
        }, 3);
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

/** Balanza simulada con varios PLU: 5005 devuelve el primero MAYOR al argumento, o código "20" si no hay. */
class SequenceScale {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  args: string[] = [];
  constructor(private records: string[]) {}
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const self = this;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const text = String.fromCharCode(...chunk);
        assert.equal(text.slice(4, 8), "5005");
        const arg = text.slice(8, 14);
        self.args.push(arg);
        const next = self.records.find((r) => Number(r.slice(0, 6)) > Number(arg));
        const reply = next ? kretzReply("H", "01", "05", "01", next) : kretzReply("H", "01", "05", "20");
        setTimeout(() => controller.enqueue(new Uint8Array(reply)), 2);
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

describe("descubrimiento de balanza Kretz (solo lectura)", () => {
  it("el control de solo lectura deja pasar pruebas y lecturas y frena escrituras", () => {
    for (const c of ["0001", "0002", "1500", "1999", "5002", "5005"]) assert.equal(isReadOnlyCommand(c), true, c);
    for (const c of ["0000", "1001", "1010", "2005", "3005", "4005", "6000", "abcd"]) assert.equal(isReadOnlyCommand(c), false, c);
    assert.throws(() => assertReadOnly("2005"), /Bloqueado/);
  });

  it("encuentra una Aura que contesta con otra letra y su número de balanza, lee su formato y NUNCA manda un comando de escritura", async () => {
    const scale = new FakeKretzScale("P", "03");
    const record = await runKretzDiscovery(scale as unknown as SerialPort, "prueba", getKretzModel("aura"), {
      balanceNumber: "3",
      frameTimeoutMs: 15,
      listenMs: 20
    });
    assert.equal(record.verdict, "datos");
    assert.deepEqual(record.responder, { link: { baudRate: 9600, stopBits: 2 }, deviceType: "P", equipmentId: "03" });
    assert.deepEqual(record.reads.map((r) => [r.command, r.code]), [["0002", "01"], ["1500", "01"], ["5002", "01"], ["5005", "01"]]);
    assert.equal(record.reads.find((r) => r.command === "5005")?.dataText, "000001ASADO");
    // Todo lo que viajó por el cable: o el pedido de peso "W" o una trama de solo lectura.
    for (const chunk of scale.received) {
      if (chunk[0] === 0x57) continue;
      assert.equal(chunk[0], 0x02);
      const command = String.fromCharCode(...chunk.slice(4, 8));
      assert.equal(isReadOnlyCommand(command), true, `se mandó ${command}`);
    }
  });

  it("lee todos los PLU uno tras otro (5005 = siguiente mayor) y corta cuando la balanza dice que no hay más", async () => {
    const plus = ["000001FRUTILLA        P0000100010500000005", "000005ASADO           P0000050150000000003", "000012HUEVOS          U0000120002000000000"];
    const port = new SequenceScale(plus);
    const scan = await scanAllPlus(port as unknown as SerialPort, { link: { baudRate: 9600, stopBits: 2 }, deviceType: "H", equipmentId: "01" }, "aura", { timeoutMs: 50 });
    assert.equal(scan.stoppedBy, "fin");
    assert.equal(scan.lastCode, "20");
    assert.deepEqual(scan.records.map((r) => r.plu), [1, 5, 12]);
    assert.deepEqual(port.args, ["000000", "000001", "000005", "000012"]);
  });

  it("si la balanza devuelve siempre el mismo PLU, corta (no se queda dando vueltas)", async () => {
    const scale = new FakeKretzScale("H", "01"); // a 5005 siempre contesta el PLU 1
    const scan = await scanAllPlus(scale as unknown as SerialPort, { link: { baudRate: 9600, stopBits: 2 }, deviceType: "H", equipmentId: "01" }, "aura", { timeoutMs: 50 });
    assert.equal(scan.stoppedBy, "error");
    assert.equal(scan.records.length, 1);
  });

  it("la trama que manda es la del documento de Kretz", () => {
    assert.deepEqual(Array.from(buildKretzFrame("P", "03", "0001")).slice(0, 8), [0x02, 0x50, 0x30, 0x33, 0x30, 0x30, 0x30, 0x31]);
  });
});
