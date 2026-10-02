import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { kretzChecksum, parseKretzResponse, toHex, toPrintable } from "./kretz-frame";
import { PROBE_COMMANDS, analyzeModelProbe, assertProbeCommand, runAuraModelProbe, type ModelProbeResult } from "./aura-model-probe";

const hex = (s: string) => s.trim().split(/\s+/).map((h) => parseInt(h, 16));

function reply(group: string, code: string, data = ""): Uint8Array {
  const body = [0x07, ...Array.from("H01" + group + code + data, (c) => c.charCodeAt(0))];
  return new Uint8Array([...body, ...kretzChecksum(body), 0x04]);
}

/** Respuesta REAL de la Aura a 1500 (2026-10-02). */
const REAL_1500 = "AUI-030KMFBAPP4KAR  V1.00  6Feb24 00       ";
/** Respuesta REAL de la Aura a 5002 "05" y a 0002: grupo 00, código 02. */
const REAL_5002_REPLY = "07 48 30 31 30 30 30 32 37 32 04";

/** Anchos REALES que dio 5002 en la Report LT de Carnes Patagonia (campos 01..22, 135 caracteres). */
const REPORT_LT_WIDTHS = [6, 3, 3, 26, 26, 5, 1, 7, 6, 6, 6, 6, 6, 5, 5, 2, 4, 4, 4, 0, 0, 4];

/** Aura simulada. `widths` = modelo que contestaría 5002 (null = 5002 no existe, como contestó la real a "05"). */
class ModelAura {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  commands: string[] = [];
  constructor(private widths: number[] | null) {}
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const self = this;
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const text = String.fromCharCode(...chunk);
        const command = text.slice(4, 8);
        const data = text.slice(8, -3);
        self.commands.push(command + (data ? ` ${data}` : ""));
        let out: Uint8Array;
        if (command === "0001") out = reply("00", "01");
        else if (command === "1500") out = reply("00", "01", REAL_1500);
        else if (command === "5002" && self.widths) {
          const field = Number(data.slice(2, 4));
          out = field >= 1 && field <= self.widths.length ? reply("05", "01", `05${data.slice(2, 4)}${String(self.widths[field - 1]).padStart(3, "0")}`) : reply("05", "20");
        } else out = new Uint8Array(hex(REAL_5002_REPLY)); // "comando inexistente", como la Aura real
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

/** Modelo A (hipótesis): orden de la Report Nx, SIN campo código; los 6 dígitos son el "valor fijo". 6+16+1+6+6+4+3 = 42. */
const MODEL_A = [6, 0, 0, 16, 0, 0, 1, 6, 6, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 3, 0, 0];
/** Modelo B (hipótesis H2): código (5) ANTES del tipo, valor fijo de 1. 6+16+5+1+1+6+4+3 = 42. */
const MODEL_B = [6, 0, 0, 16, 0, 5, 1, 1, 6, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 3, 0, 0];

describe("diagnóstico del modelo de datos de la Aura (solo lectura)", () => {
  it("el candado solo deja pasar lecturas: nada que borre, reinicie o configure", () => {
    for (const [c, d] of [["0001", ""], ["1500", ""], ["5001", "05"], ["5002", "0501"], ["5002", "0522"], ["5026", ""]]) assert.doesNotThrow(() => assertProbeCommand(c, d));
    for (const [c, d] of [["5008", ""], ["3008", ""], ["2005", ""], ["2002", "0506005"], ["1003", ""], ["1002", ""], ["1070", "2012011"], ["1080", "1"], ["4005", ""], ["5002", "05"], ["5002", "0601"], ["1504", "05"], ["1524", ""]]) {
      assert.throws(() => assertProbeCommand(c, d), /Bloqueado/, `${c} ${d}`);
    }
  });

  it("con la respuesta REAL de la Aura a 5002 ('comando inexistente'), pregunta una sola vez, no insiste y lo informa", async () => {
    const aura = new ModelAura(null);
    const r = await runAuraModelProbe(aura as unknown as SerialPort, responder, { timeoutMs: 40 });
    assert.equal(aura.commands.filter((c) => c.startsWith("5002")).length, 1);
    assert.ok(aura.commands.every((c) => c.slice(0, 4) in PROBE_COMMANDS), aura.commands.join(" | "));
    const a = analyzeModelProbe(r);
    assert.equal(a.verdict, "modelo_no_disponible");
    assert.equal(a.technical.model, "AUI-030KMFBAPP4KAR");
    assert.equal(a.technical.firmware, "V1.00");
    assert.match(a.lines[0], /grupo 00, código 02/);
    // Se guardan las respuestas originales en hexadecimal y en texto.
    const ex = r.exchanges.find((e) => e.command === "5002")!;
    assert.equal(ex.rxHex, toHex(hex(REAL_5002_REPLY)));
    assert.equal(ex.rxAscii, toPrintable(hex(REAL_5002_REPLY)));
    assert.equal(aura.readable, null, "puerto cerrado al terminar");
  });

  it("si la Aura informara el modelo A (sin campo código), el informe dice que el código no se puede escribir y dónde está el tipo", async () => {
    const r = await runAuraModelProbe(new ModelAura(MODEL_A) as unknown as SerialPort, responder, { timeoutMs: 40 });
    const a = analyzeModelProbe(r);
    assert.equal(a.verdict, "codigo_no_existe");
    assert.equal(a.total, 42);
    assert.match(a.lines.join(" "), /campo 8 \(Valor fijo/);
    assert.match(a.lines.join(" "), /El tipo SÍ está en el registro, en la posición 22/);
  });

  it("si informara el modelo B (código antes que el tipo), el informe lo marca como la explicación H2", async () => {
    const a = analyzeModelProbe(await runAuraModelProbe(new ModelAura(MODEL_B) as unknown as SerialPort, responder, { timeoutMs: 40 }));
    assert.equal(a.verdict, "codigo_y_tipo_existen");
    assert.match(a.lines.join(" "), /ANTES que el tipo \(posiciones 22 y 27\)/);
  });

  it("con los anchos REALES de la Report LT (135), el análisis detecta que no encaja con el registro de 42 de la Aura", async () => {
    const a = analyzeModelProbe(await runAuraModelProbe(new ModelAura(REPORT_LT_WIDTHS) as unknown as SerialPort, responder, { timeoutMs: 40 }));
    assert.equal(a.total, 135);
    assert.equal(a.verdict, "modelo_no_coincide");
  });

  it("los datos ya registrados alcanzan para el análisis: armado con las tramas reales del 2026-10-02", () => {
    const real = (command: string, data: string, rx: string) => {
      const k = parseKretzResponse(hex(rx))!;
      return { command, data, label: PROBE_COMMANDS[command], txHex: "", rxHex: rx, rxAscii: "", group: k.group, code: k.code, responseData: k.data, checksumOk: k.checksumOk, ms: 0 };
    };
    const r: ModelProbeResult = {
      version: "registro",
      startedAt: "",
      finishedAt: "",
      responder,
      opened: true,
      detail: "",
      openLog: [],
      exchanges: [
        real("0001", "", "07 48 30 31 30 30 30 31 37 31 04"),
        real("1500", "", "07 48 30 31 30 30 30 31 41 55 49 2d 30 33 30 4b 4d 46 42 41 50 50 34 4b 41 52 20 20 56 31 2e 30 30 20 20 36 46 65 62 32 34 20 30 30 20 20 20 20 20 20 20 3c 31 04"),
        real("5002", "05", REAL_5002_REPLY)
      ]
    };
    const a = analyzeModelProbe(r);
    assert.equal(a.verdict, "modelo_no_disponible");
    assert.equal(a.technical.model, "AUI-030KMFBAPP4KAR");
    // La respuesta a 5002 es idéntica a la de 0002 (comando que la Aura no tiene).
    assert.equal(REAL_5002_REPLY, "07 48 30 31 30 30 30 32 37 32 04");
    assert.equal(r.exchanges[2].group, "00");
  });
});
