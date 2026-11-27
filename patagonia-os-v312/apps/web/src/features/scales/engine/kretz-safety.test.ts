import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installFakeLocalStorage } from "../test-fake-storage";
import { kretzChecksum } from "../../inventory/kretz/kretz-frame";
import type { EngineContext, EngineProduct } from "./types";

/**
 * [SIMULADO] Arreglos de seguridad de las Kretz (auditoría balanzas v2, sección 2): C8, C1, C13, C21, C15 y E20.
 * La Report se simula a nivel de tramas (el código real de scale-serial.ts habla con ella); la Aura con dobles de KretzIO.
 */

const WIDTHS = [6, 3, 3, 26, 26, 5, 1, 7, 6, 6, 6, 6, 6, 5, 5, 2, 4, 4, 4, 4];
const d = (v: number, w: number) => String(v).padStart(w, "0");
const t = (s: string, w: number) => s.padEnd(w, " ").slice(0, w);

/** Un producto de la Report tal como lo guarda (135 caracteres), con el campo 19 en "1000" como trae la real. */
function reportRecord(plu: number, name: string, price: number, opts: { label?: string; campo19?: number } = {}): string {
  return [d(plu, 6), d(1, 3), d(1, 3), t(name, 26), t("", 26), d(plu, 5), "P", d(0, 7), d(price, 6), d(0, 6), d(2, 6), d(0, 6), d(0, 6), d(0, 5), d(0, 5), opts.label ?? "01", d(0, 4), d(0, 4), d(opts.campo19 ?? 1000, 4), d(0, 4)].join("");
}

export class FakeReport {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  records = new Map<number, string>();
  writes: number[] = [];
  commands: string[] = [];
  opens = 0;
  closes = 0;
  /** Contesta "01" a la escritura de estos PLU sin grabar nada (lo que hace la real con algunos PLU de iTegra). */
  ignore = new Set<number>();
  /** Al leer el PLU siguiente a este número, contesta `badCode` (`badTimes` veces). */
  badAfter: number | null = null;
  badCode = "60";
  badTimes = Infinity;
  endCode = "20";
  barcodeReply = "01";
  getInfo() {
    return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
  }
  async open() {
    this.opens++;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const reply = (code: string, data = "") => {
      const body = [0x07, ...Array.from(`C0100${code}${data}`, (c) => c.charCodeAt(0))];
      setTimeout(() => {
        try {
          controller.enqueue(new Uint8Array([...body, ...kretzChecksum(body), 0x04]));
        } catch {
          // cerrado
        }
      }, 0);
    };
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (chunk[0] !== 0x02) return;
        const text = String.fromCharCode(...chunk.slice(1, chunk.length - 3));
        const command = text.slice(3, 7);
        const data = text.slice(7);
        this.commands.push(command);
        if (command === "2005") {
          const plu = Number(data.slice(0, 6));
          this.writes.push(plu);
          if (!this.ignore.has(plu)) this.records.set(plu, data);
          reply("01");
        } else if (command === "5005") {
          const after = Number(data);
          if (this.badAfter !== null && after === this.badAfter && this.badTimes > 0) {
            this.badTimes--;
            reply(this.badCode);
            return;
          }
          const next = [...this.records.keys()].filter((k) => k > after).sort((a, b) => a - b)[0];
          if (next === undefined) reply(this.endCode);
          else reply("01", this.records.get(next)!);
        } else if (command === "1070") {
          reply(this.barcodeReply);
        } else reply("02");
      }
    });
  }
  async close() {
    this.closes++;
    this.readable = null;
    this.writable = null;
  }
}

installFakeLocalStorage();
const serial = Object.assign(new EventTarget(), { getPorts: async () => [], requestPort: async () => { throw new Error("no"); } });
Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true });

const P = (id: string, code: string, name: string, unit: "kg" | "unit", priceRetail: number): EngineProduct => ({ id, code, name, unit, priceRetail, active: true }) as EngineProduct;
const ctx = (products: EngineProduct[], extra: Partial<EngineContext> = {}): EngineContext => ({ branchId: null, products, online: false, ...extra });
const noop = () => {};

async function reportSession(scale: FakeReport, products: EngineProduct[], extra: Partial<EngineContext> = {}, io?: Partial<import("./adapters/kretz").KretzIO>) {
  const { setScaleSerialPort } = await import("../../inventory/scale-serial");
  const { KretzSession, KRETZ_IO } = await import("./adapters/kretz");
  setScaleSerialPort(scale as unknown as SerialPort);
  return new KretzSession("kretz-report-lt", ctx(products, extra), "datos", { ...KRETZ_IO, ...io });
}

describe("C8: Report: una lectura con error no es un número libre", () => {
  it("la Report contesta \"60\" al leer el producto 3: no se escribe nada y se avisa", async () => {
    localStorage.clear();
    const scale = new FakeReport();
    scale.records.set(1, reportRecord(1, "VACIO", 15000));
    scale.records.set(3, reportRecord(3, "NALGA", 9000));
    scale.badAfter = 2; // leer el 3 = 5005 con argumento 2
    const products = [P("a", "1", "VACIO", "kg", 16000), P("b", "3", "MATAMBRE", "kg", 12000)];
    const s = await reportSession(scale, products);
    const prep = await s.prepare(noop);
    assert.equal(prep.canWrite, false);
    assert.match(prep.blocker ?? "", /No se pudo leer toda la balanza\. No se cambió nada/);
    await assert.rejects(() => s.sync(prep, noop));
    assert.deepEqual(scale.writes, [], "no se mandó ninguna escritura");
    assert.ok(!scale.commands.includes("1070"));
  });

  it("un \"10\" suelto al leer se reintenta y sigue normal", async () => {
    localStorage.clear();
    const scale = new FakeReport();
    scale.records.set(3, reportRecord(3, "NALGA", 9000));
    scale.badAfter = 2;
    scale.badCode = "10";
    scale.badTimes = 1;
    const s = await reportSession(scale, [P("b", "3", "MATAMBRE", "kg", 12000)]);
    const prep = await s.prepare(noop);
    assert.equal(prep.blocker, undefined);
    assert.deepEqual(prep.pending.map((x) => x.code), [3], "el 3 es de otro producto: queda para revisar, no se pisa");
  });
});

describe("C8: Aura: lista incompleta = no se escribe nada", () => {
  it("prepare con la lista incompleta frena con el aviso, y sync no manda nada", async () => {
    const { KretzSession } = await import("./adapters/kretz");
    let sent = 0;
    const io = {
      diagnose: (async () => { throw new Error("no se usa"); }) as never,
      readAuraList: (async () => ({ records: [{ plu: 1, data: "000001FRUTILLA        P0000100010500000005" }], complete: false, detail: "no se pudo leer la lista completa (después del PLU 1 la balanza contestó 10)", exchanges: [] })) as never,
      runAuraSync: (async () => { sent++; throw new Error("no se tenía que llamar"); }) as never,
      readReport: (async () => null) as never,
      sendReport: (async () => { throw new Error("no se usa"); }) as never
    };
    const s = new KretzSession("kretz-aura", ctx([P("a", "2", "MILANESA", "kg", 900)]), "datos", io);
    const prep = await s.prepare(noop);
    assert.equal(prep.canWrite, false);
    assert.match(prep.blocker ?? "", /No se pudo leer toda la balanza\. No se cambió nada/);
    await assert.rejects(() => s.sync(prep, noop));
    assert.equal(sent, 0);
  });
});

describe("C1: el formato de etiqueta de la sucursal no se pisa si hay otra balanza", () => {
  const LT = { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1, totalLength: 13, payloadType: "amount" as const };
  const ITEM = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" as const };

  it("regla pura: una balanza = se guarda; mismo formato = se guarda; otra balanza y formato distinto = no", async () => {
    const { mayWriteBranchScaleConfig } = await import("../../inventory/kretz/branch-scale-guard");
    const one = [{ key: "r1", active: true }];
    const two = [{ key: "r1", active: true }, { key: "a1", active: true }];
    assert.equal(mayWriteBranchScaleConfig({ scales: one, currentKey: "r1", existing: LT, next: ITEM }).allowed, true);
    assert.equal(mayWriteBranchScaleConfig({ scales: [], currentKey: "r1", existing: null, next: ITEM }).allowed, true, "la primera balanza del local");
    assert.equal(mayWriteBranchScaleConfig({ scales: two, currentKey: "r1", existing: ITEM, next: ITEM }).allowed, true);
    assert.deepEqual(mayWriteBranchScaleConfig({ scales: two, currentKey: "r1", existing: LT, next: ITEM }), { allowed: false, reason: "otra_balanza" });
    assert.equal(mayWriteBranchScaleConfig({ scales: two, currentKey: "r1", existing: null, next: ITEM }).allowed, false);
    assert.equal(mayWriteBranchScaleConfig({ scales: [{ key: "r1", active: true }, { key: "vieja", active: false }], currentKey: "r1", existing: LT, next: ITEM }).allowed, true, "una dada de baja no cuenta");
    assert.equal(mayWriteBranchScaleConfig({ scales: one, currentKey: "nueva", existing: LT, next: ITEM }).allowed, false, "la que se conecta y no está registrada cuenta como otra");
    assert.equal(mayWriteBranchScaleConfig({ scales: null, currentKey: "r1", existing: LT, next: ITEM }).allowed, false, "sin datos no se toca");
    assert.equal(mayWriteBranchScaleConfig({ scales: two, currentKey: "r1", existing: undefined, next: ITEM }).allowed, false, "sin el formato guardado no se puede comparar");
  });

  function reportScale() {
    const scale = new FakeReport();
    scale.records.set(10, reportRecord(10, "Vacio", 14000));
    return scale;
  }
  const vacio = P("a", "10", "Vacio", "kg", 15000);
  const online = { online: true, branchId: "suc-1", scaleKey: "r1" };

  it("Report en un local con 2 balanzas: los productos se mandan, el formato de la sucursal no se cambia y se avisa", async () => {
    localStorage.clear();
    const scale = reportScale();
    const saved: unknown[] = [];
    const s = await reportSession(scale, [vacio], online, {
      saveItemConfig: async (_b, c) => void saved.push(c ?? "default"),
      loadBranchConfig: async () => LT,
      listBranchScales: async () => [{ key: "r1", active: true }, { key: "a1", active: true }]
    });
    const out = await s.sync(await s.prepare(noop), noop);
    assert.deepEqual(scale.writes, [10], "el producto sí se manda");
    assert.equal(out.verified, 1);
    assert.deepEqual(saved, [], "no se guardó el formato");
    assert.ok(!scale.commands.includes("1070"), "tampoco se le cambia el formato a la balanza: Mostrador la seguiría leyendo mal");
    assert.equal(out.ok, false);
    assert.match(out.message, /más de una balanza: el formato de etiqueta no se cambió\. Avisamos a soporte/);
    assert.equal((out.support as { etapa?: string }).etapa, "formato_sucursal_protegido");
  });

  it("Report en un local con una sola balanza: igual que siempre (1070 + formato guardado)", async () => {
    localStorage.clear();
    const scale = reportScale();
    const saved: unknown[] = [];
    const s = await reportSession(scale, [vacio], online, {
      saveItemConfig: async (_b, c) => void saved.push(c ?? "default"),
      loadBranchConfig: async () => LT,
      listBranchScales: async () => [{ key: "r1", active: true }]
    });
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    assert.ok(scale.commands.includes("1070"));
    assert.deepEqual(saved, ["default"]);
  });

  it("Report con 2 balanzas pero el mismo formato ya guardado: se configura normal", async () => {
    localStorage.clear();
    const scale = reportScale();
    const saved: unknown[] = [];
    const s = await reportSession(scale, [vacio], online, {
      saveItemConfig: async (_b, c) => void saved.push(c ?? "default"),
      loadBranchConfig: async () => ITEM,
      listBranchScales: async () => [{ key: "r1", active: true }, { key: "a1", active: true }]
    });
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    assert.deepEqual(saved, ["default"]);
  });

  it("si la lista de balanzas viene en el contexto, se usa esa", async () => {
    localStorage.clear();
    const scale = reportScale();
    const saved: unknown[] = [];
    const s = await reportSession(scale, [vacio], { ...online, branchScales: [{ key: "r1", active: true }, { key: "s1", active: true }] } as Partial<EngineContext>, {
      saveItemConfig: async (_b, c) => void saved.push(c ?? "default"),
      loadBranchConfig: async () => LT
    });
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.deepEqual(saved, []);
  });

  it("Aura en un local con otra balanza: los productos quedan, el formato no se guarda y se avisa", async () => {
    const { KretzSession } = await import("./adapters/kretz");
    const saved: unknown[] = [];
    const io = {
      diagnose: (async () => { throw new Error("no se usa"); }) as never,
      readAuraList: (async () => ({ records: [], complete: true, detail: "", exchanges: [] })) as never,
      runAuraSync: (async (plan: { plu: number | null; action: string }[]) => ({ verdict: "ok", detail: "", written: plan.filter((x) => x.action === "crear").map((x) => ({ plu: x.plu, action: x.action })), stoppedAt: null, barcode: "ok", before: [], after: [], exchanges: [], openLog: [], startedAt: "", finishedAt: "" })) as never,
      readReport: (async () => null) as never,
      sendReport: (async () => { throw new Error("no se usa"); }) as never,
      saveItemConfig: async (_b: string, c?: unknown) => void saved.push(c ?? "default"),
      loadBranchConfig: async () => null,
      listBranchScales: async () => [{ key: "a1", active: true }, { key: "r1", active: true }]
    };
    const s = new KretzSession("kretz-aura", ctx([P("a", "2", "MILANESA", "kg", 900)], { online: true, branchId: "suc-1", scaleKey: "a1" }), "datos", io);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.verified, 1);
    assert.deepEqual(saved, []);
    assert.equal(out.ok, false);
    assert.match(out.message, /más de una balanza/);
    assert.equal((out.support as { etapa?: string }).etapa, "formato_sucursal_protegido");
  });
});
