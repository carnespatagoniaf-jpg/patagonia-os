import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeLocalStorage } from "../test-fake-storage";
import { FakeCuora } from "../../inventory/systel/systel-fake";
import { pluEanSetting } from "../../inventory/systel/systel-plu";
import { auraName } from "../../inventory/kretz/aura-sync";
import { expectedReportProduct, type ReportProductFields } from "../../inventory/scale-serial";
import { SystelSession, type SystelDeps } from "./adapters/systel";
import { KretzSession, kretzModelForLetter, makeKretzAdapter, type KretzIO } from "./adapters/kretz";
import { connectScale } from "./engine";
import { FriendlyError, friendlyKind, friendlyMessage } from "./friendly";
import { familyOrder, loadRememberedScale, rememberScale } from "./memory";
import type { EngineContext, EngineProduct, ScaleAdapter, ScaleSession } from "./types";
import type { ScaleLink } from "../sale/profile";

const noop = () => {};

// ── Systel: registros REALES de Los gringos (respaldo 14/10, huella b8c2d441), uno de cada forma ─────────────
const T1 = "\u0001";
const T0 = "\u0000";
const Z = "0".repeat(56);
const SP = "0".repeat(44) + "          0 ";
const GRINGOS: [number, string][] = [
  [1, `00010ALPINA CAJON DE   08200007800000001010000U00000000N                              ${Z}${T1}000000000000N`],
  [4, `00040POLLO ENTEROxKG   00520000000000004010000P00000000N                              ${Z}${T1}000000000000N`],
  [13, `00130PECHUGA S/H x1x3  00920000900000013010000P00000000N                              ${SP}${T1}20PPPPCCCCCCN`],
  [86, `00860CRINKLE KG        00900000000000086010000P00000000N                              ${SP}${T0}20PPPPCCCCCCN`],
  [97, `00970BOCADITOS CAJA    05200004900000097010000U00000000N                              ${SP}${T0}21PPPPCCCCCCN`],
  [98, `00981ARABES            00090000090000098080000U00000000N                              ${Z}${T1}000000000000N`]
];
const P = (id: string, code: string, name: string, unit = "kg", priceRetail = 0): EngineProduct => ({ id, code, name, unit, priceRetail });
const GRINGOS_PRODUCTS = [P("p1", "1", "ALPINA CAJON DE 15 KG", "unit"), P("p4", "4", "POLLO ENTEROxKG"), P("p13", "13", "PECHUGA S/H x1x3"), P("p86", "86", "CRINKLE KG"), P("p78", "78", "ARABES", "unit"), P("p103", "103", "BOC.MUZ X CAJA", "box")];

function cuora(protocol = "0060") {
  const f = new FakeCuora("max60", { address: 20, protocol, typeByteAccepted: "ascii", loteNulOnWrite: true });
  for (const [n, raw] of GRINGOS) f.plus.set(n, raw);
  return f;
}

function fakeDb(initial: ScaleSetup | null = null) {
  const calls: { catalog?: { code: number; eanConfig: string | null }[]; links?: ScaleLink[]; active?: boolean; backup?: unknown } = {};
  const deps: SystelDeps = {
    loadSetup: async () => initial,
    saveCatalog: async (_b, _p, catalog) => void (calls.catalog = catalog.map((c) => ({ code: c.code, eanConfig: c.eanConfig }))),
    setLinks: async (_b, _k, links) => void (calls.links = links),
    setActive: async (_b, _k, active) => void (calls.active = active),
    saveLocalBackup: (b) => void (calls.backup = b)
  };
  return { deps, calls };
}
const ctx = (products = GRINGOS_PRODUCTS): EngineContext => ({ branchId: "b1", products, online: true });

beforeEach(() => installFakeLocalStorage());

describe("[SIMULADO, registros REALES] Mi balanza con una Systel Cuora Max: Patagonia → balanza", () => {
  // Patagonia (con precios). 13 ya está igual; 97 en la balanza es otro producto; 78 no está en la balanza; 98 está solo en la balanza.
  const PRODUCTS = [
    P("p1", "1", "ALPINA CAJON DE 15 KG", "unit", 82000),
    P("p4", "4", "POLLO ENTEROxKG", "kg", 5400),
    P("p13", "13", "PECHUGA S/H x1x3", "kg", 9200),
    P("p86", "86", "CRINKLE KG", "kg", 9000),
    P("p97", "97", "PECHUGA MAYORISTA", "kg", 8000),
    P("p78", "78", "ARABES", "unit", 1000),
    P("p500", "500", "SIN PRECIO", "kg", 0),
    P("pX", "VAC-1", "CODIGO RARO", "kg", 100)
  ];
  const lab = (deps: SystelDeps): SystelDeps => ({ ...deps, forceWritable: true });

  it("prepara: qué se manda, qué ya está, qué es de otro producto y qué no se toca", async () => {
    const { deps } = fakeDb();
    const prep = await new SystelSession(cuora(), 20, ctx(PRODUCTS), lab(deps)).prepare(noop);
    assert.equal(prep.model, "systel-cuora-max");
    assert.equal(prep.canWrite, true);
    assert.equal(prep.ready, 1); // 13
    assert.equal(prep.writes, 4); // 1 (nombre), 4 (precio), 86 (código de barras), 78 (nuevo)
    assert.deepEqual(prep.pending.map((x) => x.code), [97]);
    assert.ok(prep.notes.some((n) => /1 producto no tiene precio/.test(n)));
    assert.ok(prep.notes.some((n) => /1 producto tiene un código que no sirve/.test(n)));
    assert.ok(prep.notes.some((n) => /La balanza tiene 1 producto que no está en Patagonia: no se toca/.test(n))); // el 98
  });

  it("sincroniza: nombre, precio, forma de venta y código de cada producto; relee; Mostrador queda listo", async () => {
    const f = cuora();
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx(PRODUCTS), lab(deps));
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    const read = (n: number) => f.plus.get(n)!;
    assert.equal(read(1).slice(5, 23), "ALPINA CAJON DE 15");
    assert.equal(read(4).slice(23, 29), "005400");
    assert.equal(read(1).slice(29, 35), "078000", "la lista 2 de la balanza no se toca");
    assert.deepEqual(pluEanSetting(read(86)), { type: 1, config: "20PPPPCCCCCC" });
    assert.ok(read(78), "producto nuevo creado");
    assert.equal(read(78).slice(5, 23), "ARABES            ");
    assert.deepEqual(pluEanSetting(read(78)), { type: 1, config: "21PPPPCCCCCC" });
    assert.equal(read(97), GRINGOS.find(([n]) => n === 97)![1], "el 97 (otro producto en la balanza) no se toca");
    assert.equal(read(98), GRINGOS.find(([n]) => n === 98)![1], "lo que Patagonia no tiene no se toca");
    assert.equal(f.plus.has(500), false);
    assert.ok(calls.backup, "copia guardada antes de escribir");
    assert.deepEqual(calls.links!.map((l) => `${l.code}→${l.productId}`).sort(), ["13→p13", "1→p1", "4→p4", "78→p78", "86→p86"]);
    assert.equal(calls.active, true);
    assert.ok(f.received.every((r) => ![5, 9, 26, 32, 42].includes(r.fn)), "nunca borra ni cierra ventas");
  });

  it("con autorización, reemplaza el número ocupado por el producto de Patagonia", async () => {
    const f = cuora();
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx(PRODUCTS), lab(deps));
    const out = await s.sync(await s.prepare(noop), noop, { allowReplace: true });
    assert.equal(out.ok, true);
    assert.equal(f.plus.get(97)!.slice(5, 23), "PECHUGA MAYORISTA ");
    assert.equal(out.pending.length, 0);
  });

  it("la segunda vez no escribe nada", async () => {
    const f = cuora();
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx(PRODUCTS), lab(deps));
    await s.sync(await s.prepare(noop), noop);
    const before = f.received.length;
    const s2 = new SystelSession(f, 20, ctx(PRODUCTS), lab(deps));
    const prep2 = await s2.prepare(noop);
    assert.equal(prep2.writes, 0);
    await s2.sync(prep2, noop);
    assert.ok(f.received.slice(before).every((r) => r.fn !== 61));
  });

  it("si la balanza guarda otra cosa: vuelve a escribir lo que había, lo comprueba y frena sin tocar Patagonia", async () => {
    const f = cuora();
    f.corruptAfterWrite = 4;
    f.corruptOnce = true;
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx(PRODUCTS), lab(deps));
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.match(out.message, /Frenamos para cuidar tus productos/);
    assert.equal((out.support as { restored: boolean }).restored, true);
    assert.equal(f.plus.get(4)!.slice(23, 29), "005200", "el 4 quedó como estaba");
    assert.equal(calls.catalog, undefined);
  });

  it("se corta el cable a mitad: frena y no guarda nada en Patagonia", async () => {
    const f = cuora();
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx(PRODUCTS), lab(deps));
    const prep = await s.prepare(noop);
    let writes = 0;
    const orig = f.exchange.bind(f);
    f.exchange = async (frame: Uint8Array) => {
      if (frame[1] === 61 && ++writes === 2) f.silent = true;
      return orig(frame);
    };
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, false);
    assert.equal(calls.catalog, undefined);
  });

  it("si alguien cambió la balanza entre la lectura y el envío, no escribe encima", async () => {
    const f = cuora();
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx(PRODUCTS), lab(deps));
    const prep = await s.prepare(noop);
    f.plus.set(1, f.plus.get(1)!.replace("082000", "099000"));
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, false);
    assert.equal(f.plus.get(1)!.slice(23, 29), "099000");
  });

  it("Cuora Max reconocida (firma 0060, formato max60) y leída completa: se puede escribir sin el build de laboratorio (habilitado 19/10)", async () => {
    const f = cuora();
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx(PRODUCTS), deps);
    const prep = await s.prepare(noop);
    assert.equal(prep.canWrite, true);
    assert.equal(prep.blocker, undefined);
  });

  it("Systel con otra firma: nunca escribe, aunque sea el build de laboratorio", async () => {
    const f = cuora("0040");
    const { deps } = fakeDb();
    const prep = await new SystelSession(f, 20, ctx(PRODUCTS), lab(deps)).prepare(noop);
    assert.equal(prep.model, "systel-otra");
    assert.equal(prep.canWrite, false);
  });

  it("un cajero no puede mandar productos (tiene que ser el dueño o un administrador)", async () => {
    const { deps } = fakeDb();
    const prep = await new SystelSession(cuora(), 20, { ...ctx(PRODUCTS), canManageLinks: false }, lab(deps)).prepare(noop);
    assert.match(prep.blocker!, /dueño o un administrador/);
  });
});

// ── Kretz: dobles de las funciones de scale-serial (las mismas que usa la pantalla de hoy) ───────────────────
const AURA_NOW = ["000001FRUTILLA        P0000100010500000005", "000002PASTELITOS      N0000200000900000003"];

function auraIO(verdict: "ok" | "diferencia" = "ok") {
  const sent: { plu: number | null; action: string }[][] = [];
  const io: KretzIO = {
    diagnose: (async () => { throw new Error("no se usa"); }) as unknown as KretzIO["diagnose"],
    readAuraList: (async () => ({ records: AURA_NOW.map((data) => ({ plu: Number(data.slice(0, 6)), data })), complete: true, detail: "", exchanges: [] })) as unknown as KretzIO["readAuraList"],
    runAuraSync: (async (plan: { plu: number | null; action: string }[]) => {
      const todo = plan.filter((x) => ["crear", "actualizar", "reemplazar"].includes(x.action));
      sent.push(todo);
      return { verdict, detail: "", written: verdict === "ok" ? todo.map((x) => ({ plu: x.plu, action: x.action })) : [], stoppedAt: null, barcode: "ok", before: [], after: [], exchanges: [], openLog: [], startedAt: "", finishedAt: "" };
    }) as unknown as KretzIO["runAuraSync"],
    readReport: (async () => null) as unknown as KretzIO["readReport"],
    sendReport: (async () => { throw new Error("no se usa"); }) as unknown as KretzIO["sendReport"]
  };
  return { io, sent };
}

describe("[SIMULADO] Mi balanza con una Kretz Aura (mismo plan y envío que el panel en producción)", () => {
  const products = [P("a", "1", "FRUTILLA", "kg", 1050), P("b", "2", "MILANESA", "kg", 900), P("c", "500", "NUEVO", "unit", 100)];

  it("prepara: nuevo, precio cambiado y un número ocupado por otro producto (no se pisa)", async () => {
    const { io, sent } = auraIO();
    const s = new KretzSession("kretz-aura", ctx(products), "datos", io);
    const prep = await s.prepare(noop);
    assert.equal(prep.writes, 2); // 500 nuevo + 1 FRUTILLA con precio nuevo; el 2 está ocupado
    assert.deepEqual(prep.pending.map((x) => x.code), [2]);
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true);
    assert.ok(!sent[0].some((x) => x.plu === 2), "el 2 (PASTELITOS en la balanza) no se toca");
  });

  it("con autorización para reemplazar, el ocupado también se manda", async () => {
    const { io, sent } = auraIO();
    const s = new KretzSession("kretz-aura", ctx(products), "datos", io);
    const prep = await s.prepare(noop);
    const out = await s.sync(prep, noop, { allowReplace: true });
    assert.equal(out.ok, true);
    assert.ok(sent[0].some((x) => x.plu === 2 && x.action === "reemplazar"));
    assert.equal(out.pending.length, 0);
  });

  it("si la balanza guardó otra cosa, se informa con un mensaje simple", async () => {
    const { io } = auraIO("diferencia");
    const s = new KretzSession("kretz-aura", ctx(products), "datos", io);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.match(out.message, /Frenamos/);
  });

  it("al sincronizar, Mostrador de la sucursal queda leyendo el código por producto (Pre-Empaque)", async () => {
    const { io } = auraIO();
    const saved: string[] = [];
    const s = new KretzSession("kretz-aura", ctx(products), "datos", { ...io, saveItemConfig: async (b) => void saved.push(b) });
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true);
    assert.deepEqual(saved, ["b1"]);
  });

  it("modo pesaje: no hay nada que sincronizar, se explica qué hacer", async () => {
    const { io } = auraIO();
    const s = new KretzSession("kretz-aura", ctx(products), "peso", io);
    const prep = await s.prepare(noop);
    assert.ok(prep.blocker && /modo pesaje/.test(prep.blocker));
    await assert.rejects(() => s.sync(prep, noop));
  });

  it("nombres como los guarda la Aura (16 letras, sin acentos)", () => {
    assert.equal(auraName("Milanesa de pollo rebozada"), "MILANESA DE POLL");
  });
});

describe("[SIMULADO] Mi balanza con una Kretz Report", () => {
  function reportIO(initial: Record<string, ReportProductFields>, opts: { lie?: string } = {}) {
    const scale = new Map(Object.entries(initial));
    const sent: string[] = [];
    const io: KretzIO = {
      diagnose: (async () => { throw new Error("no se usa"); }) as unknown as KretzIO["diagnose"],
      readAuraList: (async () => { throw new Error("no se usa"); }) as unknown as KretzIO["readAuraList"],
      runAuraSync: (async () => { throw new Error("no se usa"); }) as unknown as KretzIO["runAuraSync"],
      readReport: (async (code: string) => scale.get(code) ?? null) as KretzIO["readReport"],
      sendReport: (async (list: Parameters<KretzIO["sendReport"]>[0]) => {
        for (const p of list) {
          sent.push(p.code);
          const e = expectedReportProduct(p);
          scale.set(p.code, p.code === opts.lie ? { ...e, price: e.price + 1 } : e);
        }
        return { attempted: list.length, skipped: [], noResponse: [], transportErrors: [], responseCodeCounts: { "01": list.length }, failed: [] };
      }) as KretzIO["sendReport"]
    };
    return { io, sent, scale };
  }
  const products = [P("a", "10", "Vacio", "kg", 15000), P("b", "11", "Matambre", "kg", 12000), P("c", "12", "Chorizo", "kg", 8000), P("d", "SIN", "Sin código", "kg", 1)];

  it("lee cada número antes de escribir: nuevo, igual, precio distinto y ocupado por otro", async () => {
    const { io, sent } = reportIO({
      "10": expectedReportProduct({ id: "a", code: "10", name: "Vacio", unit: "kg", priceRetail: 15000 }),
      "11": { ...expectedReportProduct({ id: "b", code: "11", name: "Matambre", unit: "kg", priceRetail: 12000 }), price: 11000 },
      "12": { name: "NALGA", byWeight: true, price: 9000 }
    });
    const s = new KretzSession("kretz-report-lt", ctx(products), "datos", io);
    const prep = await s.prepare(noop);
    assert.equal(prep.ready, 1);
    assert.equal(prep.writes, 1);
    assert.deepEqual(prep.pending.map((x) => x.code), [12]);
    assert.deepEqual(prep.skipped?.map((x) => x.code), ["SIN"]);
    assert.match(prep.skipped![0].reason, /no es un número/);
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true);
    assert.equal(out.verified, 1);
    assert.deepEqual(sent, ["11"]);
  });

  it("balanza nueva: el producto de ejemplo de fábrica (\"NOMBRE\") se reemplaza solo, sin tildar nada (real M2 Alimentos)", async () => {
    const { io, sent, scale } = reportIO({ "10": { name: "NOMBRE 00010", byWeight: false, price: 61 } });
    const s = new KretzSession("kretz-report-lt", ctx(products.slice(0, 1)), "datos", io);
    const prep = await s.prepare(noop);
    assert.equal(prep.pending.length, 0, "no lo toma como ocupado");
    assert.equal(prep.writes, 1);
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true);
    assert.deepEqual(sent, ["10"]);
    assert.equal(scale.get("10")?.byWeight, true);
  });

  it("mismo nombre y precio pero con impuesto en la balanza (imprimía $12.100 en vez de $10.000): se vuelve a grabar sin impuesto", async () => {
    const vacio = P("a", "1", "vacio", "kg", 10000);
    const { io, sent, scale } = reportIO({ "1": { ...expectedReportProduct({ id: "a", code: "1", name: "vacio", unit: "kg", priceRetail: 10000 }), taxes: 2100 } });
    const s = new KretzSession("kretz-report-lt", ctx([vacio]), "datos", io);
    const prep = await s.prepare(noop);
    assert.equal(prep.ready, 0);
    assert.equal(prep.writes, 1);
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true);
    assert.deepEqual(sent, ["1"]);
    assert.equal(scale.get("1")?.taxes, 0);
  });

  it("después de mandar, configura el código de barras de las etiquetas (1070) y deja a Mostrador leyéndolo", async () => {
    const { io } = reportIO({});
    const calls: string[] = [];
    io.configureReportBarcode = async () => { calls.push("1070"); return "ok"; };
    io.saveItemConfig = async (branchId: string) => { calls.push(`mostrador:${branchId}`); };
    const c = { ...ctx(products.slice(0, 1)), online: true, branchId: "suc-1" };
    const s = new KretzSession("kretz-report-lt", c, "datos", io);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true);
    assert.deepEqual(calls, ["1070", "mostrador:suc-1"]);
  });

  it("código de barras SIEMPRE: con los productos ya iguales igual se configura, y va antes que los productos", async () => {
    localStorage.clear();
    const vacio = P("a", "10", "Vacio", "kg", 15000);
    const { io } = reportIO({ "10": expectedReportProduct({ id: "a", code: "10", name: "Vacio", unit: "kg", priceRetail: 15000 }) });
    const calls: string[] = [];
    io.configureReportBarcode = async () => { calls.push("1070"); return "ok"; };
    const s = new KretzSession("kretz-report-lt", { ...ctx([vacio]), scaleKey: "m2" }, "datos", io);
    const prep = await s.prepare(noop);
    assert.equal(prep.writes, 0);
    assert.equal(prep.upToDate, false, "sin código de barras configurado no está 'todo listo'");
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true);
    assert.deepEqual(calls, ["1070"]);
    assert.equal((await new KretzSession("kretz-report-lt", { ...ctx([vacio]), scaleKey: "m2" }, "datos", io).prepare(noop)).upToDate, true);
  });

  it("si la balanza no acepta el código de barras, no dice 'Listo'", async () => {
    localStorage.clear();
    const { io } = reportIO({});
    io.configureReportBarcode = async () => "rechazada";
    const s = new KretzSession("kretz-report-lt", ctx(products.slice(0, 1)), "datos", io);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.equal(out.verified, 1);
    assert.match(out.message, /código de barras/);
  });

  it("verificación: si lo releído no es lo mandado, no dice 'listo'", async () => {
    const { io } = reportIO({}, { lie: "10" });
    const s = new KretzSession("kretz-report-lt", ctx(products.slice(0, 1)), "datos", io);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.deepEqual(out.failures?.map((f) => f.code), ["10"]);
    assert.match(out.failures![0].reason, /precio quedó \$15001 \(tenía que ser \$15000\)/);
  });

  it("modelo Kretz desconocido: solo lectura, sin botón de sincronizar", async () => {
    assert.equal(kretzModelForLetter("H"), "kretz-aura");
    assert.equal(kretzModelForLetter("C"), "kretz-report-lt");
    assert.equal(kretzModelForLetter("Z"), "kretz-otra");
    const { io } = reportIO({});
    const prep = await new KretzSession("kretz-otra", ctx(products), "datos", io).prepare(noop);
    assert.equal(prep.canWrite, false);
    assert.ok(prep.blocker);
  });

  // Real 16/10: la Report LT de Carnes Patagonia (115200, "C") no contestaba porque "Mi balanza" solo la buscaba como Aura.
  function kretzSearchIO(answersAs: "aura" | "report-lt" | null, searched: string[]): KretzIO {
    const diagnose = (async (_p: unknown, o: { modelId?: string } = {}) => {
      searched.push(o.modelId ?? "");
      if (o.modelId !== answersAs) return { verdict: "nada", portLabel: "USB", dataSettings: null, message: "no contestó" };
      return { verdict: "datos", portLabel: "USB", message: "", dataSettings: { baudRate: answersAs === "aura" ? 9600 : 115200, stopBits: answersAs === "aura" ? 2 : 1, deviceType: answersAs === "aura" ? "H" : "C", equipmentId: "01" } };
    }) as unknown as KretzIO["diagnose"];
    return { ...reportIO({}).io, diagnose };
  }

  it("encuentra una Report LT aunque nunca se haya usado en esta PC (busca como Aura y después como Report)", async () => {
    const searched: string[] = [];
    const s = await makeKretzAdapter(kretzSearchIO("report-lt", searched), () => null).identify(port(0x1a86), ctx(products), noop);
    assert.equal(s?.model, "kretz-report-lt");
    assert.deepEqual(searched, ["aura", "report-lt"]);
  });

  it("si en esta PC ya se usó una Report LT, la busca primero así", async () => {
    const searched: string[] = [];
    const s = await makeKretzAdapter(kretzSearchIO("report-lt", searched), () => "report-lt").identify(port(0x1a86), ctx(products), noop);
    assert.equal(s?.model, "kretz-report-lt");
    assert.deepEqual(searched, ["report-lt"]);
  });

  it("una Aura se sigue encontrando en el primer intento", async () => {
    const searched: string[] = [];
    const s = await makeKretzAdapter(kretzSearchIO("aura", searched), () => null).identify(port(0x1a86), ctx(products), noop);
    assert.equal(s?.model, "kretz-aura");
    assert.deepEqual(searched, ["aura"]);
  });

  it("si el cliente eligió Kretz Report, conecta solo como Report (sin pasar por la búsqueda de la Aura)", async () => {
    const searched: string[] = [];
    const s = await makeKretzAdapter(kretzSearchIO("report-lt", searched), () => "aura", "report-lt").identify(port(0x1a86), ctx(products), noop);
    assert.equal(s?.model, "kretz-report-lt");
    assert.deepEqual(searched, ["report-lt"]);
  });

  it("si no contesta de ninguna forma, el detalle de los dos intentos va a soporte", async () => {
    const searched: string[] = [];
    await assert.rejects(() => makeKretzAdapter(kretzSearchIO(null, searched), () => null).identify(port(0x1a86), ctx(products), noop), /aura.*report-lt/);
    assert.deepEqual(searched, ["aura", "report-lt"]);
  });
});

// ── Conectar: permiso, puerto recordado, orden de marcas y errores en palabras simples ─────────────────────
function port(vendor: number, product = 1): SerialPort {
  return { getInfo: () => ({ usbVendorId: vendor, usbProductId: product }) } as unknown as SerialPort;
}
function adapter(family: "systel" | "kretz", answers: boolean, tried: string[], err?: Error): ScaleAdapter {
  return {
    family,
    identify: async () => {
      tried.push(family);
      if (err) throw err;
      return answers ? ({ model: family === "systel" ? "systel-cuora-max" : "kretz-aura", label: family } as unknown as ScaleSession) : null;
    }
  };
}

describe("[SIMULADO] Conectar balanza", () => {
  it("cable FTDI → prueba Systel primero; lo recuerda para la próxima (sin volver a pedir permiso)", async () => {
    const tried: string[] = [];
    let asked = 0;
    const ftdi = port(0x0403, 0x6001);
    const serial = { getPorts: async () => [ftdi], requestPort: async () => (asked++, ftdi) };
    await connectScale(ctx(), noop, { serial, adapters: [adapter("kretz", true, tried), adapter("systel", true, tried)] });
    assert.deepEqual(tried, ["systel"]);
    assert.equal(asked, 1);
    assert.equal(loadRememberedScale()?.usb, "0403:6001");
    await connectScale(ctx(), noop, { serial, adapters: [adapter("kretz", true, tried), adapter("systel", true, tried)] });
    assert.equal(asked, 1, "la segunda vez usa el puerto ya autorizado");
  });

  it("otro chip → Kretz primero; si no contesta, prueba la otra marca", async () => {
    const tried: string[] = [];
    const serial = { getPorts: async () => [], requestPort: async () => port(0x1a86) };
    const s = await connectScale(ctx(), noop, { serial, adapters: [adapter("systel", true, tried), adapter("kretz", false, tried)] });
    assert.deepEqual(tried, ["kretz", "systel"]);
    assert.equal(s.model, "systel-cuora-max");
  });

  it("nadie contesta → mensaje simple (sin datos técnicos)", async () => {
    const serial = { getPorts: async () => [], requestPort: async () => port(0x1a86) };
    await assert.rejects(() => connectScale(ctx(), noop, { serial, adapters: [adapter("kretz", false, []), adapter("systel", false, [])] }), (e: unknown) => e instanceof FriendlyError && e.kind === "no_contesta" && /Revisá que esté prendida/.test(e.message));
  });

  it("cancela la lista de puertos → le decimos que elija la balanza", async () => {
    const serial = { getPorts: async () => [], requestPort: async () => { const e = new Error("No port selected by the user."); e.name = "NotFoundError"; throw e; } };
    await assert.rejects(() => connectScale(ctx(), noop, { serial, adapters: [] }), (e: unknown) => e instanceof FriendlyError && e.kind === "sin_eleccion");
  });

  it("puerto tomado por otra pestaña → no sigue probando marcas", async () => {
    const tried: string[] = [];
    const serial = { getPorts: async () => [], requestPort: async () => port(0x0403) };
    const busy = new Error("Failed to open serial port.");
    busy.name = "InvalidStateError";
    await assert.rejects(() => connectScale(ctx(), noop, { serial, adapters: [adapter("systel", false, tried, busy), adapter("kretz", true, tried)] }), (e: unknown) => e instanceof FriendlyError && e.kind === "puerto_ocupado");
    assert.deepEqual(tried, ["systel"]);
  });

  it("sin Web Serial (celular, Firefox) → usá Chrome o Edge", async () => {
    await assert.rejects(() => connectScale(ctx(), noop, { serial: null, adapters: [] }), (e: unknown) => e instanceof FriendlyError && e.kind === "sin_navegador");
  });

  it("orden recordado y mensajes", () => {
    rememberScale({ model: "kretz-aura", label: "Kretz Aura", family: "kretz", usb: "0403:6001", connectedAt: "", syncedAt: null });
    assert.deepEqual(familyOrder("0403:6001", loadRememberedScale()), ["kretz", "systel"]);
    assert.equal(friendlyKind(new Error("The port is already open.")), "puerto_ocupado");
    assert.ok(!/Error|undefined|properties/.test(friendlyMessage(new TypeError("Cannot read properties of undefined"))));
  });
});

describe("[SIMULADO, registros REALES] Systel que solo atiende pedidos al general (0): igual pasa productos y releé", () => {
  it("lee, sincroniza y verifica usando el número que atiende; la balanza queda con nombre y precio de Patagonia", async () => {
    const f = new FakeCuora("max60", { address: 20, protocol: "0060", typeByteAccepted: "ascii", loteNulOnWrite: true, deafToOwnNumber: true });
    for (const [n, raw] of GRINGOS) f.plus.set(n, raw);
    const { deps } = fakeDb();
    const products = [P("p4", "4", "POLLO ENTEROxKG", "kg", 5400), P("p78", "78", "ARABES", "unit", 1000)];
    const s = new SystelSession(f, 20, ctx(products), deps);
    const prep = await s.prepare(noop);
    assert.equal(prep.model, "systel-cuora-max");
    assert.equal(prep.canWrite, true);
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true, out.message);
    assert.equal(f.plus.get(4)!.slice(23, 29), "005400", "precio nuevo en la balanza");
    assert.equal(f.plus.get(78)!.slice(5, 23), "ARABES            ", "producto nuevo creado");
    assert.equal((s.supportInfo() as { direccion_pedidos: number }).direccion_pedidos, 0);
  });
});
