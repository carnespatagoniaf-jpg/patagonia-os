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
  mute = false;
  constructor(private records: string[]) {}
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const self = this;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (self.mute) return;
        const text = String.fromCharCode(...chunk);
        if (text.slice(4, 8) === "0001") {
          setTimeout(() => controller.enqueue(new Uint8Array(kretzReply("H", "01", "00", "01"))), 2);
          return;
        }
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

  it("si la balanza no contesta ni el test de conexión, lo dice (y no intenta leer)", async () => {
    const silent = new SequenceScale([]);
    silent.mute = true;
    const scan = await scanAllPlus(silent as unknown as SerialPort, { link: { baudRate: 9600, stopBits: 2 }, deviceType: "H", equipmentId: "01" }, "aura", { timeoutMs: 30 });
    assert.equal(scan.stoppedBy, "error");
    assert.match(scan.lastDetail, /test de conexión/);
    assert.equal(silent.args.length, 0);
  });

  it("si la balanza devuelve siempre el mismo PLU, corta (no se queda dando vueltas)", async () => {
    const scale = new FakeKretzScale("H", "01"); // a 5005 siempre contesta el PLU 1
    const scan = await scanAllPlus(scale as unknown as SerialPort, { link: { baudRate: 9600, stopBits: 2 }, deviceType: "H", equipmentId: "01" }, "aura", { timeoutMs: 50 });
    assert.equal(scan.stoppedBy, "error");
    assert.equal(scan.records.length, 1);
  });

  it("adaptador trabado (caso real CH340): rechaza 9600 hasta abrirlo antes en otra velocidad, y la lectura igual anda", async () => {
    const plus = ["000001FRUTILLA        P0000100010500000005"];
    const port = new SequenceScale(plus);
    let primed = false;
    const realOpen = port.open.bind(port);
    (port as unknown as { open: (o: SerialOptions) => Promise<void> }).open = async (o: SerialOptions) => {
      if (o.baudRate === 9600 && !primed) throw Object.assign(new Error("Failed to execute open on SerialPort: Failed to open serial port."), { name: "NetworkError" });
      if (o.baudRate === 4800) primed = true;
      await realOpen();
    };
    const scan = await scanAllPlus(port as unknown as SerialPort, { link: { baudRate: 9600, stopBits: 2 }, deviceType: "H", equipmentId: "01" }, "aura", { timeoutMs: 50 });
    assert.equal(scan.records.length, 1);
    assert.ok(scan.openLog?.some((o) => o.settings.includes("destrabar") && o.ok));
  });

  it("si Windows no deja abrir el puerto en ninguna velocidad: corta en la etapa 'abrir', no manda nada y lo dice", async () => {
    const sent: Uint8Array[] = [];
    const blocked = {
      readable: null,
      writable: null,
      async open() {
        throw Object.assign(new Error("Failed to execute 'open' on 'SerialPort': Failed to open serial port."), { name: "NetworkError" });
      },
      async close() {}
    };
    const record = await runKretzDiscovery(blocked as unknown as SerialPort, "prueba", getKretzModel("aura"), { releaseOtherTabs: false, openTries: 1, frameTimeoutMs: 10 });
    assert.equal(record.verdict, "puerto");
    assert.deepEqual(record.stages?.map((s) => [s.id, s.status]), [["dispositivo", "ok"], ["abrir", "falla"], ["enviar", "no_llego"], ["recibir", "no_llego"], ["interpretar", "no_llego"]]);
    assert.match(record.stages![1].detail, /ninguna velocidad/);
    assert.equal(sent.length, 0);
  });

  it("con la Aura que contesta: todas las etapas en verde", async () => {
    const scale = new FakeKretzScale("H", "01");
    const record = await runKretzDiscovery(scale as unknown as SerialPort, "prueba", getKretzModel("aura"), { releaseOtherTabs: false, frameTimeoutMs: 30 });
    assert.equal(record.verdict, "datos");
    assert.ok(record.stages?.every((s) => s.status === "ok"), JSON.stringify(record.stages));
    // Primero prueba la combinación ya comprobada (H, 9600/2): no hace falta barrer.
    assert.equal(record.exchanges[0].tx.slice(0, 11), "02 48 30 31");
  });

  it("la trama que manda es la del documento de Kretz", () => {
    assert.deepEqual(Array.from(buildKretzFrame("P", "03", "0001")).slice(0, 8), [0x02, 0x50, 0x30, 0x33, 0x30, 0x30, 0x30, 0x31]);
  });
});
