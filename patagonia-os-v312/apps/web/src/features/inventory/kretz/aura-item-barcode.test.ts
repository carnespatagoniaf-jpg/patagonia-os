import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AURA_BARCODE_CONFIG, AURA_ITEM_SCALE_CONFIG, setAuraItemBarcodes } from "./aura-sync";
import { kretzChecksum } from "./kretz-frame";
import { parseAuraSumTicket, parseWeightBarcode } from "../../sale/scale-barcode";

function reply(group: string, code: string, data = ""): Uint8Array {
  const body = [0x07, ...Array.from("H01" + group + code + data, (c) => c.charCodeAt(0))];
  return new Uint8Array([...body, ...kretzChecksum(body), 0x04]);
}

/** Aura simulada: contesta 0001 y 1070 como la real; el 1080 según el caso que se quiera probar. */
class Aura1080 {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  commands: { command: string; data: string }[] = [];
  constructor(public on1080: "acepta" | "inexistente" | "mudo", public on1070: "acepta" | "rechaza" = "acepta") {}
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const self = this;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const text = String.fromCharCode(...chunk);
        const command = text.slice(4, 8);
        const data = text.slice(8, -3);
        self.commands.push({ command, data });
        let out: Uint8Array | null;
        if (command === "0001") out = reply("00", "01");
        else if (command === "1070") out = reply("00", self.on1070 === "acepta" ? "01" : "05");
        else if (command === "1080") out = self.on1080 === "acepta" ? reply("00", "01") : self.on1080 === "inexistente" ? reply("00", "02") : null;
        else out = reply("00", "02");
        if (out) setTimeout(() => controller.enqueue(out!), 2);
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}
const responder = { link: { baudRate: 9600, stopBits: 2 as const }, deviceType: "H", equipmentId: "01" };

function ean13(first12: string): string {
  const sum = first12.split("").map(Number).reduce((a, d, i) => a + d * (i % 2 ? 3 : 1), 0);
  return first12 + ((10 - (sum % 10)) % 10);
}

describe("código de barras por producto en el ticket de la Aura (1080)", () => {
  it("al activar manda SOLO 0001, el formato 2-3-7 (1070) y 1080 \"1\"", async () => {
    const aura = new Aura1080("acepta");
    const r = await setAuraItemBarcodes(aura as unknown as SerialPort, responder, true, { timeoutMs: 200 });
    assert.equal(r.verdict, "ok", r.detail);
    assert.deepEqual(aura.commands, [
      { command: "0001", data: "" },
      { command: "1070", data: AURA_BARCODE_CONFIG },
      { command: "1080", data: "1" }
    ]);
  });

  it("al apagar manda 1080 \"0\" y no toca el formato", async () => {
    const aura = new Aura1080("acepta");
    const r = await setAuraItemBarcodes(aura as unknown as SerialPort, responder, false, { timeoutMs: 200 });
    assert.equal(r.verdict, "ok");
    assert.deepEqual(aura.commands.map((c) => `${c.command}${c.data}`), ["0001", "10800"]);
  });

  it("si la Aura no tiene el comando (02), lo dice y no queda nada a medias", async () => {
    const r = await setAuraItemBarcodes(new Aura1080("inexistente") as unknown as SerialPort, responder, true, { timeoutMs: 200 });
    assert.equal(r.verdict, "rechazada");
    assert.equal(r.itemCode, "02");
    assert.match(r.detail, /no tiene esa opción/);
  });

  it("si la Aura no contesta el 1080, lo informa", async () => {
    const r = await setAuraItemBarcodes(new Aura1080("mudo") as unknown as SerialPort, responder, true, { timeoutMs: 200 });
    assert.equal(r.verdict, "sin_respuesta");
  });

  it("si rechaza el formato, ni siquiera manda el 1080", async () => {
    const aura = new Aura1080("acepta", "rechaza");
    const r = await setAuraItemBarcodes(aura as unknown as SerialPort, responder, true, { timeoutMs: 200 });
    assert.equal(r.verdict, "rechazada");
    assert.ok(!aura.commands.some((c) => c.command === "1080"));
  });
});

describe("Mostrador lee los códigos de la Aura en 2-3-7 con importe", () => {
  it("renglón: PICADA COMÚN (código 66), $6.360", () => {
    const code = ean13("20" + "066" + "0636000");
    assert.equal(parseAuraSumTicket(code), null, "no es un ticket de total");
    assert.deepEqual(parseWeightBarcode(code, AURA_ITEM_SCALE_CONFIG), { plu: "66", kind: "amount", amount: 6360 });
  });

  it("el código del total (998) sigue entrando como total", () => {
    const code = ean13("20" + "998" + "3965100");
    assert.deepEqual(parseAuraSumTicket(code), { amount: 39651, format: "2-3-7" });
  });

  it("todos los códigos de producto de 1 a 662 (los de la clienta) se leen como producto, nunca como total", () => {
    for (let c = 1; c <= 662; c++) {
      const code = ean13("20" + String(c).padStart(3, "0") + "0123456");
      assert.equal(parseAuraSumTicket(code), null, `código ${c}`);
      assert.equal(parseWeightBarcode(code, AURA_ITEM_SCALE_CONFIG)?.plu, String(c));
    }
  });
});
