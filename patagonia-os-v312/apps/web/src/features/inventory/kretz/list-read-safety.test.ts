import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAuraList, runAuraSync, planAuraSync } from "./aura-sync";
import { scanAllPlus } from "./discovery";
import { kretzChecksum } from "./kretz-frame";

/**
 * C8 (auditoría balanzas v2): leer la lista de productos de una Kretz con 5005. Solo "20" (registro inexistente) y
 * "40" (no hay registros, lo que contesta la Aura real al final) son el fin de la lista. Cualquier otra respuesta
 * ("10" checksum, "60" error…) es un error: se reintenta esa lectura una vez y, si sigue mal, la lectura queda
 * incompleta. Antes se tomaba como fin: los productos siguientes parecían libres y el envío los "creaba" encima.
 */

function reply(group: string, code: string, data = ""): Uint8Array {
  const body = [0x07, ...Array.from("H01" + group + code + data, (c) => c.charCodeAt(0))];
  return new Uint8Array([...body, ...kretzChecksum(body), 0x04]);
}

const AURA_RECORDS = Array.from({ length: 10 }, (_, i) => {
  const plu = String(i + 1).padStart(6, "0");
  return `${plu}${`PRODUCTO ${i + 1}`.padEnd(16, " ")}D${String((i + 1) * 10).padStart(6, "0")}0010000000000`.slice(0, 42);
});

/** Aura simulada: 10 productos; al pedir el siguiente del `badAfter` contesta `badCode` (`badTimes` veces). */
class FlakyAura {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  commands: string[] = [];
  constructor(private records: string[], private badAfter: number | null, private badCode = "10", private badTimes = Infinity, private endCode = "40") {}
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        const text = String.fromCharCode(...chunk);
        const command = text.slice(4, 8);
        const data = text.slice(8, -3);
        this.commands.push(command);
        let out: Uint8Array;
        if (command === "0001") out = reply("00", "01");
        else if (command === "5005") {
          const after = Number(data);
          if (this.badAfter !== null && after === this.badAfter && this.badTimes > 0) {
            this.badTimes--;
            out = reply("05", this.badCode);
          } else {
            const next = this.records.find((r) => Number(r.slice(0, 6)) > after);
            out = next ? reply("05", "01", next) : reply("05", this.endCode);
          }
        } else out = reply("00", "01");
        setTimeout(() => {
          try {
            controller.enqueue(out);
          } catch {
            // cerrado
          }
        }, 1);
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

const responder = { link: { baudRate: 9600, stopBits: 2 as const }, deviceType: "H", equipmentId: "01" };

describe("C8: una respuesta de error en la lista de la Kretz nunca es el fin de la lista", () => {
  it("la balanza contesta \"10\" (checksum) en el producto 3 de 10, siempre: la lectura queda incompleta", async () => {
    const r = await readAuraList(new FlakyAura(AURA_RECORDS, 2) as unknown as SerialPort, responder, { timeoutMs: 40 });
    assert.equal(r.complete, false);
    assert.match(r.detail, /no se pudo leer/);
  });

  it("\"60\" (error al ejecutar) en el medio: scanAllPlus dice error, no fin", async () => {
    const scan = await scanAllPlus(new FlakyAura(AURA_RECORDS, 4, "60") as unknown as SerialPort, responder, "aura", { timeoutMs: 40 });
    assert.equal(scan.stoppedBy, "error");
    assert.equal(scan.records.length, 4);
  });

  it("un \"10\" suelto se reintenta una vez y la lista sale completa", async () => {
    const r = await readAuraList(new FlakyAura(AURA_RECORDS, 2, "10", 1) as unknown as SerialPort, responder, { timeoutMs: 40 });
    assert.equal(r.complete, true);
    assert.equal(r.records.length, 10);
  });

  it("\"20\" (registro inexistente) y \"40\" (no hay registros, la Aura real) son el fin de la lista", async () => {
    for (const end of ["20", "40"]) {
      const r = await readAuraList(new FlakyAura(AURA_RECORDS, null, "10", 0, end) as unknown as SerialPort, responder, { timeoutMs: 40 });
      assert.equal(r.complete, true, end);
      assert.equal(r.records.length, 10);
    }
  });

  it("el envío a la Aura no escribe NADA si la lista de antes no se pudo leer entera", async () => {
    const products = AURA_RECORDS.map((_, i) => ({ code: String(i + 1), name: `PRODUCTO ${i + 1}`, byWeight: true, price: (i + 1) * 10 + 1 }));
    // Plan armado con lo que se "leyó" hasta el error: los 7 siguientes parecían libres.
    const plan = planAuraSync(AURA_RECORDS.slice(0, 3), products);
    const scale = new FlakyAura(AURA_RECORDS, 2);
    const r = await runAuraSync(scale as unknown as SerialPort, responder, plan, { timeoutMs: 40 });
    assert.equal(r.verdict, "lectura_incompleta");
    assert.equal(r.written.length, 0);
    assert.ok(!scale.commands.includes("2005"), "no se mandó ninguna escritura");
  });
});
