import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installFakeLocalStorage } from "../scales/test-fake-storage";
import { kretzChecksum } from "./kretz/kretz-frame";

/**
 * [SIMULADO] Envío completo a una Kretz Report, con el código REAL (tramas 2005/5005 de scale-serial.ts y el
 * adaptador de "Mi balanza"), contra una balanza simulada que guarda los registros de 135 caracteres tal cual llegan
 * y los devuelve con 5005 ("el próximo PLU mayor al argumento", como la real).
 *
 * Criterio del dueño (24/10): 100 productos válidos mandados = 100 correctos en la balanza. Precio = el de Stock,
 * sin impuestos, mismo código, nombre limpio, kilo o unidad, y si uno falla se dice cuál y por qué.
 */
const WIDTHS = [6, 3, 3, 26, 26, 5, 1, 7, 6, 6, 6, 6, 6, 5, 5, 2, 4, 4, 4, 4];

function split(record: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (const w of WIDTHS) {
    out.push(record.slice(i, i + w));
    i += w;
  }
  return out;
}

/** El producto de ejemplo de fábrica de una Report nueva: "NOMBRE 0000N", impuesto 21%, etiqueta 00, otros decimales. */
function factoryRecord(plu: number): string {
  const d = (v: number, w: number) => String(v).padStart(w, "0");
  const t = (s: string, w: number) => s.padEnd(w, " ");
  return [d(plu, 6), d(1, 3), d(1, 3), t(`NOMBRE ${d(plu, 5)}`, 26), t("", 26), d(plu, 5), "N", d(0, 7), d(955481, 6), d(0, 6), d(0, 6), d(2100, 6), d(0, 6), d(0, 5), d(0, 5), "00", d(0, 4), d(0, 4), d(0, 4), d(0, 4)].join("");
}

class FakeReportScale {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  records = new Map<number, string>();
  writes: number[] = [];
  /** PLUs en los que la balanza contesta "01" pero no graba nada (lo que hace la real con algunos PLUs de iTegra). */
  ignore = new Set<number>();
  getInfo() {
    return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
  }
  async open() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const reply = (code: string, data = "") => {
      const body = [0x07, ..."C01".split("").map((c) => c.charCodeAt(0)), 0x30, 0x30, ...code.split("").map((c) => c.charCodeAt(0)), ...Array.from(data, (c) => c.charCodeAt(0))];
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
        if (command === "2005") {
          assert.equal(data.length, 135, "el registro 2005 tiene que tener 135 caracteres");
          const plu = Number(data.slice(0, 6));
          this.writes.push(plu);
          if (!this.ignore.has(plu)) this.records.set(plu, data);
          reply("01");
        } else if (command === "5005") {
          const after = Number(data);
          const next = [...this.records.keys()].filter((k) => k > after).sort((a, b) => a - b)[0];
          if (next === undefined) reply("02");
          else reply("01", this.records.get(next)!);
        } else if (command === "1070") {
          reply("01");
        } else {
          reply("02");
        }
      }
    });
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

installFakeLocalStorage();
const serial = Object.assign(new EventTarget(), { getPorts: async () => [], requestPort: async () => { throw new Error("no"); } });
Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true });

type Product = { id: string; code: string; name: string; unit: string; priceRetail: number; active?: boolean };

async function session(scale: FakeReportScale, products: Product[]) {
  const { setScaleSerialPort } = await import("./scale-serial");
  const { KretzSession } = await import("../scales/engine/adapters/kretz");
  setScaleSerialPort(scale as unknown as SerialPort);
  return new KretzSession("kretz-report-lt", { branchId: null, products, online: false }, "datos");
}
const noop = () => {};

/** 100 productos como los de una carnicería: kilo y unidad, acentos, ñ, símbolos, nombres largos. */
function catalog(): Product[] {
  const names = ["Vacío", "Matambre", "Tapa de asado", "Roast beef", "Peceto", "Nalga", "Bola de lomo", "Cuadrada", "Ñoquis caseros", "Milanesa de pollo rebozada extra grande"];
  return Array.from({ length: 100 }, (_, i) => ({
    id: `p${i + 1}`,
    code: String(i + 1),
    name: `${names[i % names.length]} ${i + 1}${i % 7 === 0 ? " ½ kg" : ""}${i % 11 === 0 ? " Nº1" : ""}`,
    unit: i % 4 === 3 ? "unit" : "kg",
    priceRetail: 1000 + i * 137
  }));
}

describe("[SIMULADO] Kretz Report: 100 productos de punta a punta (tramas reales 2005/5005)", () => {
  it("balanza nueva con productos de fábrica (impuesto 21%, etiqueta 00): los 100 quedan exactos y se verifican", async () => {
    const scale = new FakeReportScale();
    for (let plu = 1; plu <= 100; plu++) scale.records.set(plu, factoryRecord(plu));
    const products = catalog();
    const s = await session(scale, products);
    const prep = await s.prepare(noop);
    assert.equal(prep.writes, 100);
    assert.equal(prep.pending.length, 0, "los de fábrica no cuentan como ocupados");
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true, out.message);
    assert.equal(out.verified, 100);
    assert.equal(out.failures, undefined);

    for (const p of products) {
      const f = split(scale.records.get(Number(p.code))!);
      assert.equal(Number(f[0]), Number(p.code), "número de PLU");
      assert.equal(Number(f[5]), Number(p.code), "código de PLU (el del código de barras)");
      assert.equal(f[6], p.unit === "kg" ? "P" : "N", "kilo o unidad");
      assert.equal(Number(f[8]), p.priceRetail, `precio de ${p.name}: el de Stock, sin cambios`);
      assert.equal(f[10], "000002", "pesos enteros");
      assert.equal(Number(f[11]) + Number(f[12]), 0, "sin impuestos");
      assert.equal(f[15], "01", "etiqueta con código de barras");
      assert.match(f[3], /^[\x20-\x7e]{26}$/, "nombre solo con letras que la balanza tiene");
      assert.doesNotMatch(f[3], /\?|NOMBRE/, "sin signos raros ni el nombre de fábrica");
    }
    // "Vacío 1 ½ kg Nº1": sin acento, sin los símbolos que la balanza no tiene, sin espacios dobles.
    assert.equal(split(scale.records.get(1)!)[3].trimEnd(), "Vacio 1 kg N1");
  });

  it("una segunda sincronización no vuelve a mandar nada (códigos estables) y un precio nuevo de Stock sale en la siguiente", async () => {
    const scale = new FakeReportScale();
    const products = catalog();
    let s = await session(scale, products);
    assert.equal((await s.sync(await s.prepare(noop), noop)).verified, 100);

    s = await session(scale, products);
    const again = await s.prepare(noop);
    assert.equal(again.upToDate, true);
    assert.equal(again.ready, 100);

    const changed = products.map((p) => (p.code === "42" ? { ...p, priceRetail: 15500 } : p));
    scale.writes = [];
    s = await session(scale, changed);
    const prep = await s.prepare(noop);
    assert.equal(prep.writes, 1);
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true);
    assert.deepEqual(scale.writes, [42]);
    assert.equal(Number(split(scale.records.get(42)!)[8]), 15500, "$15.500 en Stock = $15.500 en la balanza (no $18.755)");
  });

  it("los productos que no pueden ir tal cual no se mandan, y cada uno dice por qué (nunca se trunca ni se redondea)", async () => {
    const scale = new FakeReportScale();
    const ok = catalog().slice(0, 3);
    const bad: Product[] = [
      { id: "x1", code: "0", name: "Código cero", unit: "kg", priceRetail: 1000 },
      { id: "x2", code: "7790001234567", name: "Aceite", unit: "unit", priceRetail: 3000 },
      { id: "x3", code: "500", name: "Con centavos", unit: "kg", priceRetail: 1234.5 },
      { id: "x4", code: "501", name: "Carísimo", unit: "kg", priceRetail: 1500000 },
      { id: "x5", code: "502", name: "Sin precio", unit: "kg", priceRetail: 0 },
      { id: "x6", code: "503", name: "½", unit: "kg", priceRetail: 1000 },
      { id: "x7", code: "504", name: "Uno", unit: "kg", priceRetail: 1000 },
      { id: "x8", code: "504", name: "Otro con el mismo código", unit: "kg", priceRetail: 1000 }
    ];
    const s = await session(scale, [...ok, ...bad]);
    const prep = await s.prepare(noop);
    const reasons = Object.fromEntries((prep.skipped ?? []).map((x) => [x.name, x.reason]));
    assert.match(reasons["Código cero"], /código es 0/);
    assert.match(reasons["Aceite"], /código de barras de fábrica/);
    assert.match(reasons["Con centavos"], /centavos/);
    assert.match(reasons["Carísimo"], /más alto/);
    assert.match(reasons["Sin precio"], /precio/);
    assert.match(reasons["½"], /nombre/);
    assert.match(reasons["Uno"], /2 productos con el código 504/);
    assert.match(reasons["Otro con el mismo código"], /2 productos con el código 504/);
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true);
    assert.equal(out.verified, 3);
    assert.deepEqual([...scale.records.keys()].sort((a, b) => a - b), [1, 2, 3], "solo se grabaron los válidos");
  });

  it("si la balanza dice que sí pero no graba un producto, no dice 'Listo': nombra ese producto y qué quedó mal", async () => {
    const scale = new FakeReportScale();
    for (let plu = 1; plu <= 100; plu++) scale.records.set(plu, factoryRecord(plu));
    scale.ignore.add(37);
    const s = await session(scale, catalog());
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.equal(out.verified, 99);
    assert.equal(out.failures?.length, 1);
    assert.equal(out.failures?.[0].code, "37");
    assert.match(out.failures![0].reason, /nombre quedó "NOMBRE 00037"/);
    assert.match(out.failures![0].reason, /precio quedó \$955481/);
    assert.match(out.failures![0].reason, /impuesto/);
    assert.match(out.failures![0].reason, /etiqueta/);
    assert.match(out.message, /1 producto no quedó bien.*99 sí/);
  });
});
