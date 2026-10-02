import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { kretzChecksum, parseKretzResponse, toHex, toPrintable } from "./kretz-frame";
import { PROBE_COMMANDS, UNVERIFIED_ENABLED, VERIFIED_COMMANDS, analyzeModelProbe, assertProbeCommand, runAuraModelProbe, type ModelProbeResult, type ProbeExchange } from "./aura-model-probe";

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

const CLIENT_SIX = [
  "000001FRUTILLA        P0000100010500000005",
  "000002PASTELITOS      N0000200000900000003",
  "000003PAN NEGRO       P0000300004800100001",
  "000006MILA BERENJENA  D0000600052000000000",
  "000008PROMO           C0000800189000000000",
  "000011HAMB POLLO      D0001100108000000000"
];

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
        else if (command === "5005") {
          const next = CLIENT_SIX.find((r) => Number(r.slice(0, 6)) > Number(data));
          out = next ? reply("05", "01", next) : reply("05", "40");
        }
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

/** Arma un resultado como si la Aura hubiera contestado 5002 con estos anchos (solo para probar el ANÁLISIS; el botón no manda 5002). */
function withModel(widths: number[]): ModelProbeResult {
  const ex = (command: string, data: string, group: string, code: string, responseData: string): ProbeExchange => ({ command, data, label: PROBE_COMMANDS[command], txHex: "", rxHex: "", rxAscii: "", group, code, responseData, checksumOk: true, ms: 0 });
  return {
    version: "simulado",
    startedAt: "",
    finishedAt: "",
    responder,
    opened: true,
    detail: "",
    openLog: [],
    exchanges: [
      ex("0001", "", "00", "01", ""),
      ex("1500", "", "00", "01", REAL_1500),
      ...widths.map((w, i) => ex("5002", `05${String(i + 1).padStart(2, "0")}`, "05", "01", `05${String(i + 1).padStart(2, "0")}${String(w).padStart(3, "0")}`))
    ]
  };
}

describe("diagnóstico de la Aura con un botón (solo lecturas ya comprobadas en esta Aura)", () => {
  it("los comandos no comprobados (5001, 5002, 5026) están deshabilitados en el código", () => {
    assert.equal(UNVERIFIED_ENABLED, false);
    assert.deepEqual(Object.keys(VERIFIED_COMMANDS).sort(), ["0001", "1500", "5005"]);
  });

  it("el candado solo deja pasar 0001, 1500 y 5005 con un número de 6 dígitos", () => {
    for (const [c, d] of [["0001", ""], ["1500", ""], ["5005", "000000"], ["5005", "000011"]]) assert.doesNotThrow(() => assertProbeCommand(c, d));
    for (const [c, d] of [
      ["5002", "0501"], ["5002", "05"], ["5001", "05"], ["5026", ""], ["0002", ""], ["5008", ""], ["3008", ""], ["2005", ""], ["3005", "000096"],
      ["4005", ""], ["2002", "0506005"], ["1003", ""], ["1002", ""], ["1070", "2012011"], ["1080", "1"], ["5005", "05"], ["1500", "X"]
    ]) {
      assert.throws(() => assertProbeCommand(c, d), /Bloqueado/, `${c} ${d}`);
    }
  });

  it("el botón manda solo 0001, 1500 y 5005; lee todos los productos y guarda cada respuesta en hexadecimal y texto", async () => {
    const aura = new ModelAura(null);
    const r = await runAuraModelProbe(aura as unknown as SerialPort, responder, { timeoutMs: 40 });
    assert.ok(aura.commands.every((c) => ["0001", "1500", "5005"].includes(c.slice(0, 4))), aura.commands.join(" | "));
    assert.deepEqual(aura.commands, ["0001", "1500", "5005 000000", "5005 000001", "5005 000002", "5005 000003", "5005 000006", "5005 000008", "5005 000011"]);
    const a = analyzeModelProbe(r);
    assert.equal(a.verdict, "modelo_no_consultado");
    assert.deepEqual(a.products, CLIENT_SIX);
    assert.equal(a.technical.model, "AUI-030KMFBAPP4KAR");
    for (const e of r.exchanges) {
      assert.match(e.txHex, /^02 48 30 31/);
      assert.match(e.rxHex, /^07 48 30 31/);
      assert.ok(e.rxAscii.length > 0);
    }
    assert.equal(aura.readable, null, "puerto cerrado al terminar");
  });

  it("análisis (para el día que se habilite 5002): modelo sin campo código", () => {
    const a = analyzeModelProbe(withModel(MODEL_A));
    assert.equal(a.verdict, "codigo_no_existe");
    assert.equal(a.total, 42);
    assert.ok(a.lines.join(" ").includes("campo 8 (Valor fijo"));
  });

  it("análisis: código antes que el tipo (H2)", () => {
    const a = analyzeModelProbe(withModel(MODEL_B));
    assert.equal(a.verdict, "codigo_y_tipo_existen");
    assert.ok(a.lines.join(" ").includes("ANTES que el tipo (posiciones 22 y 27)"));
  });

  it("análisis con los anchos REALES de la Report LT (135): no encaja con el registro de 42 de la Aura", () => {
    const a = analyzeModelProbe(withModel(REPORT_LT_WIDTHS));
    assert.equal(a.total, 135);
    assert.equal(a.verdict, "modelo_no_coincide");
  });

  it("con las tramas YA registradas (5002 '05' → comando inexistente) el análisis lo dice sin otra conexión", () => {
    const real = (command: string, data: string, rx: string): ProbeExchange => {
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
    assert.match(a.lines[0], /grupo 00, código 02/);
    assert.equal(toHex(hex(REAL_5002_REPLY)), REAL_5002_REPLY);
    assert.equal(toPrintable(hex(REAL_5002_REPLY)).length > 0, true);
  });
});
