import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auraWriteToReadOrder } from "./aura-plu";
import { AURA_PREVIOUS_TEST_READBACKS, AURA_TEST_RECORDS, assertTestWrite, runAuraWriteTest } from "./aura-write-test";
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
  /** Mundo "H3": la balanza ignora tipo y código aunque vengan bien (pone D y 0). */
  zeroCode = false;
  /** Para simular que la balanza guarda otro precio. */
  manglePrice = false;
  /** Para simular un desastre: al cargar este PLU, también cambia un producto de la clienta. */
  corruptOnWrite: number | null = null;
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
            // Como la Aura real: con el formato de escritura (código 22-27 y tipo P/N en 28) guarda tipo y código.
            // REAL 2026-10-03: el código vuelve en 5 dígitos + "0" (000097 → 000970). Escrito a mano, sin usar auraWriteToReadOrder.
            // y los devuelve en orden de lectura; con cualquier otra cosa en esas posiciones pone "D" y 0 (lo visto el 2026-10-02).
            const writeFormat = /^[0-9]{6}$/.test(data.slice(22, 28)) && "PNDC".includes(data[28]);
            let stored = writeFormat && !self.zeroCode ? data.slice(0, 22) + data[28] + data.slice(23, 28) + "0" + data.slice(29) : data.slice(0, 22) + "D000000" + data.slice(29);
            if (self.manglePrice) stored = stored.slice(0, 29) + "009999" + stored.slice(35);
            self.plus = self.plus.filter((r) => r.slice(0, 6) !== data.slice(0, 6)).concat(stored);
            out = reply("02", "01");
          }
          if (self.corruptOnWrite !== null && Number(data.slice(0, 6)) === self.corruptOnWrite) {
            self.plus = self.plus.map((r) => (r.startsWith("000001") ? r.replace("FRUTILLA", "FRUTILLX") : r));
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

describe("prueba de escritura de la Aura (solo PLU 96 a 99)", () => {
  it("carga los 4 productos de prueba, los relee y no toca los de la clienta (con el 99 de la primera prueba ya cargado)", async () => {
    const aura = new MemoryAura([...REAL_SIX, ...AURA_PREVIOUS_TEST_READBACKS]);
    const r = await runAuraWriteTest(aura as unknown as SerialPort, responder, { timeoutMs: 50 });
    assert.equal(r.verdict, "ok", r.detail);
    assert.deepEqual(r.items.map((it) => it.plu), [97, 98, 96, 99, 97]);
    assert.equal(r.verdict, "ok", r.detail);
    assert.ok(r.items.every((it) => it.readBack === auraWriteToReadOrder(it.sent)), JSON.stringify(r.items));
    assert.deepEqual(r.items.map((it) => it.readBack![22]), ["D", "C", "C", "D", "D"]);
    assert.deepEqual(r.items.map((it) => it.readBack!.slice(23, 29)), ["000970", "000980", "009600", "005000", "000970"]);
    // Cambio de precio: el PLU 97 pasa de 2000 a 2100 y conserva tipo, código, tara (0) y validez (2 días).
    assert.equal(r.items[4].readBack, "000097PRUEBA KILO     D0009700260000000002");
    assert.deepEqual(r.after.filter((x) => x.plu < 90).map((x) => x.data), REAL_SIX);
    assert.equal(aura.commands.filter((c) => c === "2005").length, 5);
    // Nunca un borrado: solo test de conexión, lecturas y las 4 cargas.
    assert.ok(aura.commands.every((c) => ["0001", "5005", "2005"].includes(c)), aura.commands.join(","));
    assert.deepEqual(r.after.filter((x) => x.plu >= 96).map((x) => x.plu), [96, 97, 98, 99]);
    assert.equal(aura.readable, null, "el puerto queda cerrado");
  });

  it("si la balanza igual ignorara tipo y código (pone D y 0), frena en el primero y lo informa campo por campo", async () => {
    const aura = new MemoryAura([...REAL_SIX]);
    aura.zeroCode = true;
    const r = await runAuraWriteTest(aura as unknown as SerialPort, responder, { timeoutMs: 50 });
    assert.equal(r.verdict, "diferencia");
    assert.match(r.detail, /codigo/);
    assert.equal(aura.commands.filter((c) => c === "2005").length, 1);
    assert.equal(r.items[0].same?.precio, true);
  });

  it("si algún PLU de prueba tiene otro producto, no escribe nada", async () => {
    for (const other of ["000097OTRA COSA       C0009700005000000000", "000099OTRA COSA       P0009900005000000000"]) {
      const aura = new MemoryAura([...REAL_SIX, other]);
      const r = await runAuraWriteTest(aura as unknown as SerialPort, responder, { timeoutMs: 50 });
      assert.equal(r.verdict, "plu_ocupado");
      assert.ok(!aura.commands.includes("2005"));
    }
  });

  it("si la balanza no deja leer la lista completa, no escribe nada", async () => {
    const aura = new MemoryAura([...REAL_SIX]);
    const realOpen = aura.open.bind(aura);
    aura.open = async () => {
      await realOpen();
      const w = aura.writable!;
      let n = 0;
      aura.writable = new WritableStream<Uint8Array>({
        async write(chunk) {
          n++;
          if (n > 3) return; // después del 0001 y dos lecturas se queda muda
          const writer = w.getWriter();
          await writer.write(chunk);
          writer.releaseLock();
        }
      });
    };
    const r = await runAuraWriteTest(aura as unknown as SerialPort, responder, { timeoutMs: 30 });
    assert.equal(r.verdict, "lectura_incompleta");
    assert.ok(!aura.commands.includes("2005"));
  });

  it("si la balanza rechaza una carga, frena ahí y deja constancia de que los de la clienta no cambiaron", async () => {
    const aura = new MemoryAura([...REAL_SIX]);
    aura.rejectWrites = true;
    const r = await runAuraWriteTest(aura as unknown as SerialPort, responder, { timeoutMs: 50 });
    assert.equal(r.verdict, "rechazada");
    assert.equal(aura.commands.filter((c) => c === "2005").length, 1);
    assert.deepEqual(r.after.map((x) => x.data), REAL_SIX);
  });

  it("si un producto de prueba vuelve con otro precio, frena ahí: no carga los siguientes", async () => {
    const aura = new MemoryAura([...REAL_SIX]);
    aura.manglePrice = true;
    const r = await runAuraWriteTest(aura as unknown as SerialPort, responder, { timeoutMs: 50 });
    assert.equal(r.verdict, "diferencia");
    assert.match(r.detail, /precio/);
    assert.equal(aura.commands.filter((c) => c === "2005").length, 1);
  });

  it("si al cargar un producto de prueba cambia uno de la clienta, frena ahí: no carga los siguientes", async () => {
    const aura = new MemoryAura([...REAL_SIX]);
    aura.corruptOnWrite = 97; // el primero que se carga
    const r = await runAuraWriteTest(aura as unknown as SerialPort, responder, { timeoutMs: 50 });
    assert.equal(r.verdict, "otros_cambiaron");
    assert.equal(aura.commands.filter((c) => c === "2005").length, 1);
  });

  it("el candado no deja escribir otra cosa", () => {
    for (const real of REAL_SIX) assert.throws(() => assertTestWrite("2005", real), /Bloqueado/);
    assert.throws(() => assertTestWrite("3005", AURA_TEST_RECORDS[0]), /Bloqueado/);
    for (const rec of AURA_TEST_RECORDS) assert.doesNotThrow(() => assertTestWrite("2005", rec));
    assert.deepEqual(AURA_TEST_RECORDS.map((r) => Number(r.slice(0, 6))), [97, 98, 96, 99]);
  });
});
