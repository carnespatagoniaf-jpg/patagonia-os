import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AURA_TEST_RECORD, assertTestWrite, runAuraWriteTest } from "./aura-write-test";
import { kretzChecksum } from "./kretz-frame";

const REAL_SIX = [
  "000001FRUTILLA        P0000100010500000005",
  "000002PASTELITOS      N0000200000900000003",
  "000003PAN NEGRO       P0000300004800100001",
  "000006MILA BERENJENA  D0000600052000000000",
  "000008PROMO           C0000800189000000000",
  "000011HAMB POLLO      D0001100108000000000"
];

function reply(group: string, code: string, data = ""): Uint8Array {
  const body = [0x07, ...Array.from("H01" + group + code + data, (c) => c.charCodeAt(0))];
  return new Uint8Array([...body, ...kretzChecksum(body), 0x04]);
}

/** Aura simulada con memoria: 0001, 5005 (siguiente mayor) y 2005 (guarda el registro de 42). Anota cada comando. */
class MemoryAura {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  commands: string[] = [];
  rejectWrites = false;
  constructor(public plus: string[]) {}
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const self = this;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const text = String.fromCharCode(...chunk);
        const command = text.slice(4, 8);
        const data = text.slice(8, -3);
        self.commands.push(command);
        let out: Uint8Array;
        if (command === "0001") out = reply("00", "01");
        else if (command === "5005") {
          const next = [...self.plus].sort().find((r) => Number(r.slice(0, 6)) > Number(data));
          out = next ? reply("05", "01", next) : reply("05", "20");
        } else if (command === "2005") {
          if (self.rejectWrites || data.length !== 42) out = reply("02", "05");
          else {
            self.plus = self.plus.filter((r) => r.slice(0, 6) !== data.slice(0, 6)).concat(data);
            out = reply("02", "01");
          }
        } else out = reply("00", "02");
        setTimeout(() => controller.enqueue(out), 2);
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

const responder = { link: { baudRate: 9600, stopBits: 2 as const }, deviceType: "H", equipmentId: "01" };

describe("prueba de escritura de la Aura (un producto, PLU libre)", () => {
  it("carga el producto de prueba, lo relee idéntico y no toca los productos de la clienta", async () => {
    const aura = new MemoryAura([...REAL_SIX]);
    const r = await runAuraWriteTest(aura as unknown as SerialPort, responder, { timeoutMs: 50 });
    assert.equal(r.verdict, "ok", r.detail);
    assert.equal(r.readBack, AURA_TEST_RECORD);
    assert.deepEqual(r.before.map((x) => x.data), REAL_SIX);
    assert.deepEqual(r.after.map((x) => x.data), [...REAL_SIX, AURA_TEST_RECORD]);
    // Un solo comando de escritura, nunca un borrado.
    assert.equal(aura.commands.filter((c) => c === "2005").length, 1);
    assert.ok(aura.commands.every((c) => ["0001", "5005", "2005"].includes(c)), aura.commands.join(","));
    assert.equal(aura.readable, null, "el puerto queda cerrado");
  });

  it("si el PLU de prueba ya existe, no escribe nada", async () => {
    const aura = new MemoryAura([...REAL_SIX, "000099OTRA COSA       P0009900005000000000"]);
    const r = await runAuraWriteTest(aura as unknown as SerialPort, responder, { timeoutMs: 50 });
    assert.equal(r.verdict, "plu_ocupado");
    assert.ok(!aura.commands.includes("2005"));
  });

  it("si la balanza no deja leer la lista completa, no escribe nada", async () => {
    const aura = new MemoryAura([...REAL_SIX]);
    const mute = Object.assign(aura, {});
    const realOpen = mute.open.bind(mute);
    mute.open = async () => {
      await realOpen();
      const w = mute.writable!;
      let n = 0;
      mute.writable = new WritableStream<Uint8Array>({
        async write(chunk) {
          n++;
          if (n > 3) return; // después del 0001 y dos lecturas se queda muda
          const writer = w.getWriter();
          await writer.write(chunk);
          writer.releaseLock();
        }
      });
    };
    const r = await runAuraWriteTest(mute as unknown as SerialPort, responder, { timeoutMs: 30 });
    assert.equal(r.verdict, "lectura_incompleta");
    assert.ok(!aura.commands.includes("2005"));
  });

  it("si la balanza rechaza la carga, lo dice y deja constancia de que los demás no cambiaron", async () => {
    const aura = new MemoryAura([...REAL_SIX]);
    aura.rejectWrites = true;
    const r = await runAuraWriteTest(aura as unknown as SerialPort, responder, { timeoutMs: 50 });
    assert.equal(r.verdict, "rechazada");
    assert.equal(r.writeCode, "05");
    assert.deepEqual(r.after.map((x) => x.data), REAL_SIX);
  });

  it("el candado no deja escribir otra cosa", () => {
    assert.throws(() => assertTestWrite("2005", REAL_SIX[0]), /Bloqueado/);
    assert.throws(() => assertTestWrite("3005", AURA_TEST_RECORD), /Bloqueado/);
    assert.doesNotThrow(() => assertTestWrite("2005", AURA_TEST_RECORD));
  });
});
