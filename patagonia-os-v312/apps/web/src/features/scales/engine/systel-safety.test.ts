import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeLocalStorage } from "../test-fake-storage";
import { FakeCuora } from "../../inventory/systel/systel-fake";
import { SystelClient } from "../../inventory/systel/systel-client";
import { parsePluAs } from "../../inventory/systel/systel-plu";
import { planSystelPush, runSystelPush } from "./adapters/systel-push";
import { SystelSession, type SystelDeps } from "./adapters/systel";
import type { EngineContext, EngineProduct } from "./types";
import type { ScaleLink } from "../sale/profile";

/**
 * Arreglos de seguridad Systel (plan balanzas v2, §2: C9, C10, C11, C12, C16, C24, E12, E14). Cada prueba reproduce
 * el error con el código de antes y queda como regresión. Registros REALES de Los gringos (respaldo 14/10).
 */
const noop = () => {};
const T1 = "\u0001";
const Z = "0".repeat(56);
const SP = "0".repeat(44) + "          0 ";
const GRINGOS: [number, string][] = [
  [1, `00010ALPINA CAJON DE   08200007800000001010000U00000000N                              ${Z}${T1}000000000000N`],
  [4, `00040POLLO ENTEROxKG   00520000000000004010000P00000000N                              ${Z}${T1}000000000000N`],
  [13, `00130PECHUGA S/H x1x3  00920000900000013010000P00000000N                              ${SP}${T1}20PPPPCCCCCCN`]
];
const P = (id: string, code: string, name: string, unit = "kg", priceRetail = 0): EngineProduct => ({ id, code, name, unit, priceRetail });

function cuora() {
  const f = new FakeCuora("max60", { address: 20, protocol: "0060", typeByteAccepted: "ascii", loteNulOnWrite: true });
  for (const [n, raw] of GRINGOS) f.plus.set(n, raw);
  return f;
}

function fakeDb() {
  const calls: { catalog?: { code: number; eanConfig: string | null }[]; links?: ScaleLink[]; active?: boolean; backup?: unknown } = {};
  const deps: SystelDeps = {
    loadSetup: async () => null,
    saveCatalog: async (_b, _p, catalog) => void (calls.catalog = catalog.map((c) => ({ code: c.code, eanConfig: c.eanConfig }))),
    setLinks: async (_b, _k, links) => void (calls.links = links),
    setActive: async (_b, _k, active) => void (calls.active = active),
    saveLocalBackup: (b) => void (calls.backup = b),
    forceWritable: true
  };
  return { deps, calls };
}
const ctx = (products: EngineProduct[], scaleKey?: string): EngineContext => ({ branchId: "b1", products, online: true, ...(scaleKey ? { scaleKey } : {}) });
const writesTo = (f: FakeCuora, n: number) => f.received.filter((r) => r.fn === 61 && Number(r.data.slice(0, 4)) === n);

beforeEach(() => installFakeLocalStorage());

describe("C9: antes de crear un producto, solo E7 es 'libre'", () => {
  const plusOf = (f: FakeCuora) => [...f.plus.entries()].map(([n, raw]) => ({ number: n, raw }));
  async function planFor(f: FakeCuora) {
    const client = new SystelClient(f, { address: 20, busyRetryMs: [] });
    const plus = [];
    for (const { number } of plusOf(f)) plus.push((await client.readPlu("max60", number))!);
    return planSystelPush(plus, "max60", 0, [{ id: "p78", code: "78", name: "ARABES", byWeight: false, price: 1000 }]);
  }

  it("si la lectura previa del número nuevo no contesta, no escribe", async () => {
    const f = cuora();
    const plan = await planFor(f);
    assert.equal(plan[0].action, "crear");
    const orig = f.exchange.bind(f);
    f.exchange = async (frame: Uint8Array) => (frame[1] === 62 && frame[0] === 20 && String.fromCharCode(...frame.subarray(2, 6)) === "0078" ? null : orig(frame));
    const writer = new SystelClient(f, { address: 20, busyRetryMs: [], writes: { products: true, productBarcode: true } });
    const r = await runSystelPush(writer, "max60", plan);
    assert.equal(writesTo(f, 78).length, 0, "nunca escribe a ciegas");
    assert.equal(r.stoppedAt, 78);
    assert.equal(f.plus.has(78), false);
  });

  it("si la lectura previa da otro error (E6), no escribe", async () => {
    const f = cuora();
    const plan = await planFor(f);
    const orig = f.exchange.bind(f);
    f.exchange = async (frame: Uint8Array) => {
      if (frame[1] === 62 && String.fromCharCode(...frame.subarray(2, 6)) === "0078") {
        const body = [20, 62, 0x45, 0x36];
        return Uint8Array.from([...body, body.reduce((x, b) => x ^ b, 0)]);
      }
      return orig(frame);
    };
    const writer = new SystelClient(f, { address: 20, busyRetryMs: [], writes: { products: true, productBarcode: true } });
    const r = await runSystelPush(writer, "max60", plan);
    assert.equal(writesTo(f, 78).length, 0);
    assert.notEqual(r.stoppedAt, null);
  });

  it("con E7 (libre) lo crea como siempre", async () => {
    const f = cuora();
    const plan = await planFor(f);
    const writer = new SystelClient(f, { address: 20, busyRetryMs: [], writes: { products: true, productBarcode: true } });
    const r = await runSystelPush(writer, "max60", plan);
    assert.equal(r.stoppedAt, null, r.detail);
    assert.ok(f.plus.get(78));
  });

  it("con la sesión entera: sin respuesta a la lectura previa, frena sin crear", async () => {
    const f = cuora();
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx([P("p78", "78", "ARABES", "unit", 1000)]), deps);
    const prep = await s.prepare(noop);
    const orig = f.exchange.bind(f);
    f.exchange = async (frame: Uint8Array) => (frame[1] === 62 && String.fromCharCode(...frame.subarray(2, 6)) === "0078" ? null : orig(frame));
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, false);
    assert.equal(writesTo(f, 78).length, 0);
  });
});

describe("C12: si el envío frena a mitad, Mostrador reconoce lo que ya quedó grabado", () => {
  const PRODUCTS = [P("p1", "1", "ALPINA CAJON DE 15 KG", "unit", 82000), P("p4", "4", "POLLO ENTEROxKG", "kg", 5400), P("p13", "13", "PECHUGA S/H x1x3", "kg", 9200), P("p78", "78", "ARABES", "unit", 1000)];

  it("guarda catálogo y vínculos de lo confirmado y de lo que ya estaba igual; el mensaje dice cuántos quedaron", async () => {
    const f = cuora();
    f.corruptAfterWrite = 4;
    f.corruptOnce = true;
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx(PRODUCTS), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.equal(out.verified, 1);
    assert.deepEqual(calls.catalog?.map((c) => c.code).sort((a, b) => a - b), [1, 13], "el 1 (confirmado) y el 13 (ya igual); ni el 4 (restaurado) ni el 78 (no llegó)");
    assert.deepEqual(calls.links?.map((l) => `${l.code}→${l.productId}`).sort(), ["13→p13", "1→p1"]);
    assert.match(out.message, /Quedaron grabados 1 de 3/);
  });

  it("lo que no se llegó a mandar conserva lo que Mostrador ya sabía (la balanza lo sigue teniendo así)", async () => {
    const f = cuora();
    f.corruptAfterWrite = 4;
    f.corruptOnce = true;
    const { deps, calls } = fakeDb();
    const old = { code: 4, name: "POLLO ENTEROxKG", saleType: "P" as const, prices: [5200, 0], eanType: 1, eanConfig: "20PPPPCCCCCC" };
    const old78 = { code: 77, name: "OTRO", saleType: "U" as const, prices: [100, 0], eanType: 1, eanConfig: "21PPPPCCCCCC" };
    deps.loadSetup = async () => ({ profile: { scaleKey: "systel", brand: "systel", weighedFormat: null, unitFormat: null, totalFormat: null, amountDecimals: 0, genericCodes: [], catalog: [old, old78] }, links: [{ code: 4, kind: "product", productId: "p4" }, { code: 77, kind: "product", productId: "p77" }], readAt: null, repeatWindowMinutes: 0, active: true });
    const s = new SystelSession(f, 20, ctx(PRODUCTS), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.equal((out.support as { restored: boolean }).restored, true);
    assert.deepEqual(calls.catalog?.map((c) => c.code).sort((a, b) => a - b), [1, 4, 13, 77], "el 4 quedó restaurado: sigue con lo de antes");
    assert.deepEqual(calls.links?.map((l) => `${l.code}→${l.productId}`).sort(), ["13→p13", "1→p1", "4→p4", "77→p77"]);
  });

  it("si frena en el primero y no había nada igual, no guarda nada (y no inventa vínculos)", async () => {
    const f = cuora();
    f.corruptAfterWrite = 1;
    f.corruptOnce = true;
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx([P("p1", "1", "ALPINA CAJON DE 15 KG", "unit", 82000), P("p4", "4", "POLLO ENTEROxKG", "kg", 5400)]), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.equal(calls.catalog, undefined);
    assert.equal(calls.links, undefined);
  });
});

describe("C10: un producto reemplazado o nuevo no hereda datos del registro anterior", () => {
  // Cola de un max60 con información cargada: agua, nutrición, origen, conservación, receta, lote, código e ingredientes.
  const FULL_TAIL = (type: string, config: string) => "0012" + "S" + "PORCION 100 G".padEnd(30, " ") + "0123".repeat(8) + "0003" + "0002" + "0005" + "123456789012" + type + config + "S" + "INGREDIENTES: HARINA, HUEVO, PAN RALLADO".padEnd(100, " ");
  const BLANK_EXTRAS = "0000" + "N" + " ".repeat(30) + "0000".repeat(8) + "0000" + "0000" + "0000" + "0".repeat(12);
  const extras = (raw: string) => {
    const plu = parsePluAs("max60", raw)!;
    return plu.tail.slice(0, 105 - 14);
  };
  const BOCADITOS = `00970BOCADITOS CAJA    05200004900000097010000U0000${FULL_TAIL("0", "21PPPPCCCCCC")}`;
  const ALPINA = `00010ALPINA CAJON DE   08200007800000001010000U0000${FULL_TAIL(T1, "000000000000")}`;

  it("al reemplazar un producto distinto: lista 2 en 0 y nutrición, lote, origen, receta e ingredientes en blanco", async () => {
    const f = cuora();
    f.plus.set(97, BOCADITOS);
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx([P("p97", "97", "PECHUGA MAYORISTA", "kg", 8000)]), deps);
    const out = await s.sync(await s.prepare(noop), noop, { allowReplace: true });
    assert.equal(out.ok, true, out.message);
    const now = parsePluAs("max60", f.plus.get(97)!)!;
    assert.equal(now.name.trim(), "PECHUGA MAYORISTA");
    assert.deepEqual(now.prices, [8000, 0], "la lista 2 del producto anterior no queda");
    assert.equal(extras(now.raw), BLANK_EXTRAS);
    assert.equal(now.tail.at(-1), "N", "sin los ingredientes del anterior");
    assert.equal(now.tail.length, 105);
  });

  it("al crear un producto nuevo sobre el modelo, no copia la información del modelo", async () => {
    const f = cuora();
    f.plus.set(1, ALPINA);
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx([P("p78", "78", "ARABES", "unit", 1000)]), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    const now = parsePluAs("max60", f.plus.get(78)!)!;
    assert.deepEqual(now.prices, [1000, 0]);
    assert.equal(extras(now.raw), BLANK_EXTRAS);
    assert.equal(now.tail.at(-1), "N");
    assert.equal(f.plus.get(1), ALPINA, "el modelo no se toca");
  });

  it("cambiar el precio del MISMO producto conserva todo lo demás (lista 2, nutrición, lote, ingredientes)", async () => {
    const f = cuora();
    f.plus.set(1, ALPINA);
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx([P("p1", "1", "ALPINA CAJON DE", "unit", 90000)]), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    const now = parsePluAs("max60", f.plus.get(1)!)!;
    assert.deepEqual(now.prices, [90000, 78000]);
    assert.equal(extras(now.raw), extras(ALPINA));
    assert.equal(now.tail.at(-101), "S", "los ingredientes siguen");
  });

  it("Cuora 2: al reemplazar, la lista 2 del anterior queda en 0", () => {
    const rec = "00171bola lomo         02050000150000017010000P000000N";
    const plu = parsePluAs("cuora2", rec)!;
    const [item] = planSystelPush([plu], "cuora2", 0, [{ id: "p17", code: "17", name: "CUADRADA", byWeight: true, price: 20500 }], { replace: true });
    assert.equal(item.action, "reemplazar");
    const read = item.data!.slice(0, 53) + item.data!.slice(54);
    assert.deepEqual(parsePluAs("cuora2", read)!.prices, [20500, 0]);
  });
});
