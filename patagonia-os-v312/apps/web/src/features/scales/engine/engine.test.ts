import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeLocalStorage } from "../test-fake-storage";
import { FakeCuora } from "../../inventory/systel/systel-fake";
import { pluEanSetting } from "../../inventory/systel/systel-plu";
import { auraName } from "../../inventory/kretz/aura-sync";
import { expectedReportProduct, type ReportProductFields } from "../../inventory/scale-serial";
import { SystelSession, type SystelDeps } from "./adapters/systel";
import { KretzSession, kretzModelForLetter, type KretzIO } from "./adapters/kretz";
import { connectScale } from "./engine";
import { FriendlyError, friendlyKind, friendlyMessage } from "./friendly";
import { familyOrder, loadRememberedScale, rememberScale } from "./memory";
import type { EngineContext, EngineProduct, ScaleAdapter, ScaleSession } from "./types";
import type { ScaleLink } from "../sale/profile";
import type { ScaleSetup } from "../sale/scale-sale-service";

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

describe("[SIMULADO, registros REALES] Mi balanza con una Systel Cuora Max", () => {
  it("lee, compara, configura el código de cada producto, verifica y guarda en Patagonia", async () => {
    const f = cuora();
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    const prep = await s.prepare(noop);
    assert.equal(prep.model, "systel-cuora-max");
    assert.equal(prep.canWrite, true);
    assert.equal(prep.scaleProducts, 6);
    assert.equal(prep.writes, 5); // 1, 4, 86 (tipo general), 97 (tipo general), 98 → el 13 ya estaba
    // 1 ALPINA CAJON DE (cortado) → 1; 4 y 13 iguales; 86 igual; 98 ARABES → 78 por nombre idéntico. 97 queda para revisar.
    assert.equal(prep.newLinks, 5);
    assert.deepEqual(prep.pending.map((x) => x.code), [97]);
    assert.ok(prep.notes.some((n) => /precios se siguen cargando/.test(n)));

    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true, out.message);
    assert.match(out.message, /ya podés vender/);
    for (const [n, raw] of GRINGOS) {
      const now = f.plus.get(n)!;
      assert.equal(now.slice(0, 4) + now.slice(5, 56), raw.slice(0, 4) + raw.slice(5, 56), `producto ${n}: nombre/precios/forma de venta intactos`);
      assert.equal(pluEanSetting(now).type, 1);
    }
    assert.ok(calls.backup, "respaldo guardado antes de escribir");
    assert.equal(calls.active, true);
    assert.equal(calls.catalog!.find((c) => c.code === 4)!.eanConfig, "20PPPPCCCCCC");
    assert.equal(calls.catalog!.find((c) => c.code === 1)!.eanConfig, "21PPPPCCCCCC");
    assert.deepEqual(calls.links!.map((l) => `${l.code}→${l.productId}`).sort(), ["13→p13", "1→p1", "4→p4", "86→p86", "98→p78"]);
    // Sin escribir nada en el lote: solo función 61 sobre los 5 que faltaban, nunca 32/5/9/26/42.
    assert.ok(f.received.every((r) => ![5, 9, 26, 32, 42].includes(r.fn)));
    assert.equal(f.received.filter((r) => r.fn === 61).length, 5);
  });

  it("una segunda vez no escribe nada (ya está todo listo)", async () => {
    const f = cuora();
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    await s.sync(await s.prepare(noop), noop);
    const before = f.received.length;
    const s2 = new SystelSession(f, 20, ctx(), deps);
    const prep2 = await s2.prepare(noop);
    assert.equal(prep2.writes, 0);
    await s2.sync(prep2, noop);
    assert.ok(f.received.slice(before).every((r) => r.fn !== 61));
  });

  it("balanza Systel con OTRA firma: se lee y se vincula, pero NO se escribe nada", async () => {
    const f = cuora("0040");
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    const prep = await s.prepare(noop);
    assert.equal(prep.model, "systel-otra");
    assert.equal(prep.canWrite, false);
    assert.equal(prep.writes, 0);
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true);
    assert.equal(f.received.filter((r) => r.fn === 61).length, 0);
    assert.ok(calls.catalog);
  });

  it("si la balanza cambia otra cosa al escribir: frena, restaura y NO guarda nada en Patagonia", async () => {
    const f = cuora();
    f.corruptAfterWrite = 4;
    f.corruptOnce = true;
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.match(out.message, /Frenamos para cuidar tus productos/);
    assert.equal(calls.catalog, undefined);
    assert.equal(calls.active, undefined);
  });

  it("se corta el cable a mitad (la balanza deja de contestar): frena sin guardar nada", async () => {
    const f = cuora();
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
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

  it("respeta lo que ya decidió una persona (no pisa vínculos)", async () => {
    const f = cuora();
    const setup = { profile: { scaleKey: "systel", brand: "systel", weighedFormat: null, unitFormat: null, totalFormat: null, amountDecimals: 0, genericCodes: [], catalog: [] }, links: [{ code: 97, kind: "product" as const, productId: "p103" }, { code: 4, kind: "libre" as const, productId: null }], readAt: null, repeatWindowMinutes: 3, active: true };
    const { deps, calls } = fakeDb(setup);
    const s = new SystelSession(f, 20, ctx(), deps);
    const prep = await s.prepare(noop);
    assert.equal(prep.pending.length, 0);
    await s.sync(prep, noop);
    assert.ok(!calls.links!.some((l) => l.code === 97 || l.code === 4));
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
    assert.ok(prep.notes.some((n) => /1 productos de Patagonia no van/.test(n)));
    const out = await s.sync(prep, noop);
    assert.equal(out.ok, true);
    assert.equal(out.verified, 1);
    assert.deepEqual(sent, ["11"]);
  });

  it("verificación: si lo releído no es lo mandado, no dice 'listo'", async () => {
    const { io } = reportIO({}, { lie: "10" });
    const s = new KretzSession("kretz-report-lt", ctx(products.slice(0, 1)), "datos", io);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.deepEqual(out.support, { verificacion: ["10"] });
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
