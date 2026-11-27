import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeLocalStorage } from "../test-fake-storage";
import { FakeCuora, fakeReadRecord } from "../../inventory/systel/systel-fake";
import { SystelClient } from "../../inventory/systel/systel-client";
import { parsePluAs } from "../../inventory/systel/systel-plu";
import { SerialSystelLink } from "../../inventory/systel/systel-serial";
import { ensureSystelSectors, planSystelPush, runSystelPush } from "./adapters/systel-push";
import { loadProductBackupLocally, loadWriteProof, saveProductBackupLocally, saveWriteProof, SystelSession, type SystelDeps } from "./adapters/systel";
import { loadLocalBackup, saveBackupLocally, type SystelBackup } from "../../inventory/systel/systel-backup";
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

  it("Cuora 2: al reemplazar, la lista 2 del anterior queda en 0 (plan)", () => {
    const rec = "00171bola lomo         02050000150000017010000P000000N";
    const plu = parsePluAs("cuora2", rec)!;
    const [item] = planSystelPush([plu], "cuora2", 0, [{ id: "p17", code: "17", name: "CUADRADA", byWeight: true, price: 20500 }], { replace: true });
    assert.equal(item.action, "reemplazar");
    const read = item.data!.slice(0, 53) + item.data!.slice(54);
    assert.deepEqual(parsePluAs("cuora2", read)!.prices, [20500, 0]);
  });
});

describe("C11: el tope del código sale del formato que Patagonia escribe en cada producto (20PPPPCCCCCC)", () => {
  it("Cuora Max con formato general de 5 cifras: el producto 12345 se avisa antes de mandar", async () => {
    const f = new FakeCuora("max62", { address: 20, protocol: "0062", typeByteAccepted: "ascii" });
    f.config = "Ton=2;Gris=0;Pap=0;Apa=1;Vel=5;Cpr=0;Sinc=0;E_P=20PPPPPIIIII;E_U=21PPPPPIIIII;Cim=1";
    f.plus.set(1, fakeReadRecord("max62", { number: 1, name: "ASADO", price: 9000, code: 1, type: "P" }));
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx([P("p1", "1", "ASADO", "kg", 9500), P("pq", "12345", "QUESO", "kg", 9000)]), deps);
    const prep = await s.prepare(noop);
    const skip = prep.skipped?.find((x) => x.code === "12345");
    assert.ok(skip, "el 12345 no puede ir: la etiqueta del producto lleva 4 cifras");
    assert.match(skip!.reason, /4 cifras/);
    assert.equal(prep.writes, 1, "solo el 1");
  });
});

describe("C16: sectores y 'no esperar al encender' (35 N) se comprueban antes de seguir", () => {
  const writer = (f: FakeCuora) => new SystelClient(f, { address: 20, busyRetryMs: [], writes: { products: true, productBarcode: true } });

  it("si no se pudo leer la lista de sectores (función 11), frena", async () => {
    const f = cuora(); // sin control de sectores: la 11 contesta E4
    const r = await ensureSystelSectors(writer(f), [1]);
    assert.equal(r.ok, false);
    assert.equal(f.received.filter((x) => x.fn === 10).length, 0, "no crea ninguno");
  });

  it("si la 11 contesta, sigue como siempre", async () => {
    const f = cuora();
    f.sectors = new Map([[1, "GENERAL"]]);
    const r = await ensureSystelSectors(writer(f), [1]);
    assert.equal(r.ok, true);
  });

  const SINC_ON = "Ton=2;Gris=0;Pap=0;Apa=1;Vel=5;Cpr=0;Sinc=1;E_P=20PPPPIIIIII;E_U=21PPPPIIIIII;Cim=1";

  it("después de la 35 N, si la configuración no se puede releer, frena sin mandar productos", async () => {
    const f = cuora();
    f.config = SINC_ON;
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx([P("p4", "4", "POLLO ENTEROxKG", "kg", 5400)]), deps);
    const prep = await s.prepare(noop);
    const orig = f.exchange.bind(f);
    let sent35 = false;
    f.exchange = async (frame: Uint8Array) => {
      if (frame[1] === 35) sent35 = true;
      if (sent35 && frame[1] === 39) return null;
      return orig(frame);
    };
    const out = await s.sync(prep, noop);
    assert.ok(sent35);
    assert.equal(out.ok, false);
    assert.equal(f.received.filter((x) => x.fn === 61).length, 0);
  });

  it("si la 35 N cambió otra cosa de la configuración, frena sin mandar productos", async () => {
    const f = cuora();
    f.config = SINC_ON;
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx([P("p4", "4", "POLLO ENTEROxKG", "kg", 5400)]), deps);
    const prep = await s.prepare(noop);
    const orig = f.exchange.bind(f);
    f.exchange = async (frame: Uint8Array) => {
      const r = await orig(frame);
      if (frame[1] === 35) f.config = f.config!.replace("Ton=2", "Ton=9");
      return r;
    };
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, false);
    assert.equal(f.received.filter((x) => x.fn === 61).length, 0);
  });

  it("si la balanza ignora la 35 N, manda los productos pero avisa que sigue esperando al encender", async () => {
    const f = cuora();
    f.config = SINC_ON;
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx([P("p4", "4", "POLLO ENTEROxKG", "kg", 5400)]), deps);
    const prep = await s.prepare(noop);
    const orig = f.exchange.bind(f);
    f.exchange = async (frame: Uint8Array) => {
      const before = f.config;
      const r = await orig(frame);
      if (frame[1] === 35) f.config = before;
      return r;
    };
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true, out.message);
    assert.match(out.message, /esperar a la PC/);
  });

  it("con la 35 N confirmada, sigue y no avisa nada de más", async () => {
    const f = cuora();
    f.config = SINC_ON;
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx([P("p4", "4", "POLLO ENTEROxKG", "kg", 5400)]), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    assert.doesNotMatch(out.message, /esperar a la PC/);
    assert.match(f.config!, /Sinc=0/);
  });
});

describe("C24: respaldos y prueba de escritura, uno por balanza (3 Systel en la misma PC)", () => {
  const SIG = { signature: { productType: "0001", capacityGrams: 31000, protocolVersion: "0070", pluCapacity: 3000, shortcuts: 60, priceDecimals: 0 }, layout: "max7" as const };

  it("el respaldo de productos de una balanza no pisa el de otra", () => {
    saveProductBackupLocally({ de: "A" }, "systel-a");
    saveProductBackupLocally({ de: "B" }, "systel-b");
    assert.deepEqual(loadProductBackupLocally("systel-a"), { de: "A" });
    assert.deepEqual(loadProductBackupLocally("systel-b"), { de: "B" });
  });

  it("lo guardado antes con la clave global se sigue leyendo (no se pierde)", () => {
    localStorage.setItem("patagonia-systel-product-backup", JSON.stringify({ viejo: true }));
    assert.deepEqual(loadProductBackupLocally("systel-c"), { viejo: true });
    saveProductBackupLocally({ nuevo: true }, "systel-c");
    assert.deepEqual(loadProductBackupLocally("systel-c"), { nuevo: true });
    assert.equal(localStorage.getItem("patagonia-systel-product-backup"), JSON.stringify({ viejo: true }), "la global no se toca");
  });

  it("la prueba de escritura de una balanza no habilita a otra del mismo modelo con el mismo número", () => {
    saveWriteProof(SIG, 20, "binario", "systel-a");
    assert.equal(loadWriteProof(SIG, 20, "systel-a"), "binario");
    assert.equal(loadWriteProof(SIG, 20, "systel-b"), null);
  });

  it("una prueba vieja (clave global) se sigue respetando", () => {
    localStorage.setItem("patagonia-systel-write-proof", JSON.stringify({ "0070/max7/20": "ascii" }));
    assert.equal(loadWriteProof(SIG, 20, "systel-a"), "ascii");
  });

  it("el último respaldo completo (panel de soporte) también va por balanza, con la global como respaldo", () => {
    const b = (n: number) => ({ takenAt: "", address: n, signature: null, ping: null, config: null, layout: null, list: [], plus: [], unreadable: [], complete: true, detail: "" }) as unknown as SystelBackup;
    localStorage.setItem("patagonia-systel-last-backup", JSON.stringify(b(9)));
    saveBackupLocally(b(1), "systel-a");
    saveBackupLocally(b(2), "systel-b");
    assert.equal(loadLocalBackup("systel-a")!.address, 1);
    assert.equal(loadLocalBackup("systel-b")!.address, 2);
    assert.equal(loadLocalBackup("systel-c")!.address, 9);
  });

  it("el envío guarda la copia de productos con la clave de ESA balanza", async () => {
    const f = cuora();
    const { deps } = fakeDb();
    const keys: (string | undefined)[] = [];
    deps.saveLocalBackup = (_b, key) => void keys.push(key);
    const s = new SystelSession(f, 20, ctx([P("p4", "4", "POLLO ENTEROxKG", "kg", 5400)], "systel-b"), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    assert.deepEqual(keys, ["systel-b"]);
  });
});

/** Puerto de mentira: anota las señales y lo que se escribe; contesta lo que diga `answer` (o nada). */
class RecordingPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  readonly log: string[] = [];
  answer: ((frame: Uint8Array) => Uint8Array | null) | null = null;
  async open() {
    this.log.push("abrir");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    this.writable = new WritableStream<Uint8Array>({
      write: (frame) => {
        this.log.push(`tx ${frame[0]}/${frame[1]}`);
        const a = this.answer?.(frame);
        if (a) setTimeout(() => controller.enqueue(a), 2);
      }
    });
  }
  async setSignals(s: { dataTerminalReady?: boolean; requestToSend?: boolean }) {
    this.log.push(`señales DTR=${s.dataTerminalReady} RTS=${s.requestToSend}`);
  }
  async close() {
    this.log.push("cerrar");
    this.readable = null;
    this.writable = null;
  }
}

describe("E12: al reabrir el puerto después de un corte se vuelven a poner las señales y se despierta la balanza", () => {
  it("reabre con las mismas señales DTR/RTS que tenía y manda el ping de arranque antes de la orden", async () => {
    const port = new RecordingPort();
    const link = new SerialSystelLink(port as unknown as SerialPort);
    await link.connect();
    await link.setLines(false, true);
    await link.close();
    port.log.length = 0;
    await link.exchange(Uint8Array.from([20, 2, 22]), { timeoutMs: 30 });
    const iOpen = port.log.indexOf("abrir");
    const iSignals = port.log.indexOf("señales DTR=false RTS=true");
    const iOrder = port.log.indexOf("tx 20/2");
    assert.ok(iOpen >= 0 && iSignals > iOpen, `señales guardadas después de reabrir: ${port.log.join(" | ")}`);
    assert.ok(port.log.indexOf("tx 1/23") > iSignals && port.log.indexOf("tx 0/23") > iSignals, "ping al 1 y general");
    assert.ok(iOrder > port.log.indexOf("tx 0/23"), "la orden va después del arranque");
  });

  it("la primera vez que se abre no manda nada de más", async () => {
    const port = new RecordingPort();
    const link = new SerialSystelLink(port as unknown as SerialPort);
    await link.connect();
    await link.exchange(Uint8Array.from([20, 2, 22]), { timeoutMs: 30 });
    assert.deepEqual(port.log.filter((l) => l.startsWith("tx")), ["tx 20/2"]);
    await link.close();
  });
});
