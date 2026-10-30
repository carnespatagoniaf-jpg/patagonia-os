import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeLocalStorage } from "../test-fake-storage";
import { FakeCuora } from "../../inventory/systel/systel-fake";
import { parsePluAs, pluEanSetting } from "../../inventory/systel/systel-plu";
import { SystelSession, type SystelDeps } from "./adapters/systel";
import { PROOF_NAME } from "./adapters/systel-push";
import type { EngineContext, EngineProduct } from "./types";

// ── Registros REALES de la Cuora Max de El Dorado (29/10/2026): firma F2000 C030000 S0070 P03000 A060 D0, formato max7.
// Copiados del reporte de soporte (función 62). El tipo de código es el byte 0x00 y "RIÑON" trae la Ñ como 0xD1.
const TAIL = "N" + " ".repeat(30) + "0".repeat(60) + " ".repeat(12) + "\u0000" + "IIIIIIIIIIIIN";
const ELDORADO: [number, string][] = [
  [1001, "0010010COSTILLA OFERTA   016990000000016990000000000000000000000000000000000000000000001001010000P00000000" + TAIL],
  [2004, "0020040RIÑON             006500000000006500000000000000000000000000000000000000000000002004040000P00000000" + TAIL],
  [2005, "0020050LENGUA            011890000000011890000000000000000000000000000000000000000000002005040000P00000000" + TAIL]
];

const noop = () => {};
const P = (id: string, code: string, name: string, priceRetail: number, unit = "kg"): EngineProduct => ({ id, code, name, unit, priceRetail });
const PRODUCTS = [
  P("p1001", "1001", "COSTILLA OFERTA", 16990),
  P("p2005", "2005", "LENGUA", 12500),
  P("p1002", "1002", "VACIO", 20990),
  P("p3008", "3008", "ALITA 3KG", 1996.6)
];
const ctx = (products = PRODUCTS): EngineContext => ({ branchId: "b1", products, online: true });

function eldorado(opts: { typeByteAccepted?: "ascii" | "binario" } = {}) {
  const f = new FakeCuora("max7", { address: 20, protocol: "0070", capacity: 3000, typeByteAccepted: opts.typeByteAccepted ?? "ascii", loteZerosOnWrite: true });
  for (const [n, raw] of ELDORADO) f.plus.set(n, raw);
  return f;
}

function fakeDb() {
  const calls: { catalog?: { code: number; eanConfig: string | null }[]; active?: boolean } = {};
  const deps: SystelDeps = {
    loadSetup: async () => null,
    saveCatalog: async (_b, _p, catalog) => void (calls.catalog = catalog.map((c) => ({ code: c.code, eanConfig: c.eanConfig }))),
    setLinks: async () => {},
    setActive: async (_b, _k, active) => void (calls.active = active),
    saveLocalBackup: () => {}
  };
  return { deps, calls };
}

beforeEach(() => installFakeLocalStorage());

describe("[SIMULADO, registros REALES de El Dorado] Cuora Max firmware 7.0: prueba en un número libre y después los productos", () => {
  it("los registros reales se leen como max7 (223 caracteres) con precio, código y forma de venta", () => {
    for (const [n, raw] of ELDORADO) {
      assert.equal(raw.length, 223);
      const p = parsePluAs("max7", raw, n);
      assert.ok(p, `PLU ${n}`);
      assert.equal(p!.code, n);
      assert.equal(p!.saleType, "P");
      assert.deepEqual(pluEanSetting(raw), { type: 0, config: "IIIIIIIIIIII" });
    }
  });

  it("prepara: ya no la frena; avisa del producto de prueba; el precio con centavos no va", async () => {
    const { deps } = fakeDb();
    const prep = await new SystelSession(eldorado(), 20, ctx(), deps).prepare(noop);
    assert.equal(prep.model, "systel-cuora-max");
    assert.equal(prep.canWrite, true);
    assert.equal(prep.blocker, undefined);
    assert.equal(prep.writes, 3); // 1001 (código de barras), 2005 (precio), 1002 (nuevo)
    assert.ok(prep.notes.some((n) => n.includes(PROOF_NAME)));
    assert.ok(prep.skipped?.some((s) => s.code === "3008" && /centavos/.test(s.reason)));
  });

  it("sincroniza: primero el producto de prueba en el 3000, después los productos, cada uno releído", async () => {
    const f = eldorado();
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    const writes = f.received.filter((r) => r.fn === 61).map((r) => Number(r.data.slice(0, 6)));
    assert.equal(writes[0], 3000, "la primera escritura es la de prueba, en un número libre");
    assert.equal(f.plus.get(3000)!.slice(7, 25), "PRUEBA PATAGONIA  ");
    assert.equal(f.plus.get(3000)!.slice(25, 31), "000001");
    const lengua = f.plus.get(2005)!;
    assert.equal(lengua.slice(25, 31), "012500", "precio final de Patagonia, tal cual (sin sumar IVA)");
    assert.equal(lengua.slice(37, 43), "011890", "la lista 2 de la balanza no se toca");
    assert.deepEqual(pluEanSetting(lengua), { type: 1, config: "20PPPPCCCCCC" });
    assert.equal(f.plus.get(1001)!.slice(25, 31), "016990");
    assert.ok(f.plus.get(1002), "producto nuevo creado");
    assert.equal(f.plus.get(1002)!.slice(7, 25), "VACIO             ");
    assert.equal(f.plus.get(2004), ELDORADO[1][1], "lo que Patagonia no tiene no se toca");
    assert.equal(f.plus.has(3008), false);
    assert.deepEqual(calls.catalog!.map((c) => `${c.code}:${c.eanConfig}`).sort(), ["1001:20PPPPCCCCCC", "1002:20PPPPCCCCCC", "2005:20PPPPCCCCCC"]);
    assert.equal(calls.active, true);
    assert.ok(f.received.every((r) => ![5, 9, 26, 32, 42].includes(r.fn)), "nunca borra ni cierra ventas");
  });

  it("si la balanza solo acepta el tipo de código como byte: la prueba lo descubre y el envío lo usa", async () => {
    const f = eldorado({ typeByteAccepted: "binario" });
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    assert.deepEqual(pluEanSetting(f.plus.get(2005)!), { type: 1, config: "20PPPPCCCCCC" });
    assert.equal(f.plus.get(2005)!.slice(25, 31), "012500");
  });

  it("si el producto de prueba no vuelve igual: frena y NO toca ningún producto del cliente", async () => {
    const f = eldorado();
    f.corruptAfterWrite = 3000;
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.match(out.message, /Frenamos para cuidar tus productos/);
    assert.equal((out.support as { etapa: string }).etapa, "prueba");
    for (const [n, raw] of ELDORADO) assert.equal(f.plus.get(n), raw, `PLU ${n} intacto`);
    assert.equal(f.plus.has(1002), false);
    assert.equal(calls.catalog, undefined);
  });

  it("REAL 29/10: lo que mandó Patagonia y lo que releyó la balanza de El Dorado cuentan como iguales (lote en blanco → ceros)", async () => {
    const { sameRecord } = await import("./adapters/systel-push");
    const body = "0030001PRUEBA PATAGONIA  000001" + "0".repeat(54) + "003000040000P00000000N" + " ".repeat(30) + "0".repeat(60);
    const sent = body + " ".repeat(12) + "1" + "20PPPPCCCCCCN";
    const back = body + " 00000000000" + "\u0001" + "20PPPPCCCCCCN";
    assert.equal(sent.length, 223);
    assert.equal(sameRecord("max7", sent, back), true);
    // Un lote de verdad distinto sigue frenando.
    assert.equal(sameRecord("max7", sent, body + "LOTE12345678" + "\u0001" + "20PPPPCCCCCCN"), false);
    // Y cualquier otra diferencia también (precio).
    assert.equal(sameRecord("max7", sent, back.replace("000001", "000002")), false);
  });

  it("la balanza ya tiene el producto de prueba de un intento anterior: lo reusa (ahora a $2) y sigue", async () => {
    const f = eldorado();
    const prev = "0030001PRUEBA PATAGONIA  000001" + "0".repeat(54) + "003000040000P00000000N" + " ".repeat(30) + "0".repeat(60) + " 00000000000" + "\u0001" + "20PPPPCCCCCCN";
    f.plus.set(3000, prev);
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    assert.equal(f.plus.get(3000)!.slice(25, 31), "000002");
    assert.equal(f.plus.get(2005)!.slice(25, 31), "012500");
  });

  it("REAL 29/10: al conectar, Mostrador deja de leer el importe como kilos (formato viejo guardado en la PC)", async () => {
    const { saveSystelPluBarcodes, systelConfigForCode, loadSystelLabelTemplates } = await import("../../sale/systel-label-format");
    // Lo que había quedado guardado en la PC: el 1006 "producto + kilos".
    saveSystelPluBarcodes({ "1006": { type: 1, config: "20PPPPCCCCCC", p1: 17990, saleType: "P" } });
    assert.notEqual(systelConfigForCode("2010060999341", loadSystelLabelTemplates()), "no_soportado");
    const f = eldorado();
    f.config = "Ton=2;Sinc=0;E_P=20PPPPIIIIII;E_U=21PPPPIIIIII;E_S=22AAIIIIIIII;ETi=S";
    f.plus.set(1006, "0010060BOLA DE LOMO      017990000000017990000000000000000000000000000000000000000000001006010000P00000000" + TAIL);
    const { deps } = fakeDb();
    await new SystelSession(f, 20, ctx(), deps).prepare(noop);
    const t = loadSystelLabelTemplates()!;
    assert.deepEqual(t.perPlu?.["1006"], { type: 0, config: "IIIIIIIIIIII", p1: 17990, p2: 17990, name: "BOLA DE LOMO", saleType: "P" });
    // El ticket real de El Dorado (BOLA DE LOMO $99.934): ya no se lee como kilos.
    assert.equal(systelConfigForCode("2010060999341", t), "no_soportado");
  });

  it("la segunda vez en la misma computadora no repite la prueba", async () => {
    const f = eldorado();
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    await s.sync(await s.prepare(noop), noop);
    const before = f.received.length;
    const s2 = new SystelSession(f, 20, ctx([P("p2005", "2005", "LENGUA", 13000)]), deps);
    const prep2 = await s2.prepare(noop);
    assert.ok(!prep2.notes.some((n) => n.includes(PROOF_NAME)));
    const out2 = await s2.sync(prep2, noop);
    assert.equal(out2.ok, true, out2.message);
    const writes = f.received.slice(before).filter((r) => r.fn === 61).map((r) => Number(r.data.slice(0, 6)));
    assert.deepEqual(writes, [2005]);
  });
});

describe("[SIMULADO] REAL El Dorado 29-30/10: un producto de la balanza con un byte raro en la porción", () => {
  it("se le devuelve a la balanza tal cual y la sincronización no se frena (antes: Carácter no permitido, posición 107)", async () => {
    const f = eldorado();
    // Porción con un byte nulo y una º (0xBA) desde la posición 108 de la lectura = 107 de la escritura (sin gestión).
    const raw = ELDORADO[2][1];
    const odd = raw.slice(0, 107) + "1 ºPORCION" + raw.slice(107 + 10);
    assert.equal(odd.length, 223);
    f.plus.set(2005, odd);
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    const lengua = f.plus.get(2005)!;
    assert.equal(lengua.slice(25, 31), "012500");
    assert.equal(lengua.slice(107, 117), "1 ºPORCION", "la porción de la balanza queda igual");
  });
});
