import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeLocalStorage } from "../test-fake-storage";
import { FakeCuora } from "../../inventory/systel/systel-fake";
import { parsePluAs } from "../../inventory/systel/systel-plu";
import { SystelSession, type SystelDeps } from "./adapters/systel";
import { cuora2WriteData, CUORA2_FIXED, PROOF_NAME } from "./adapters/systel-push";
import type { EngineContext, EngineProduct } from "./types";

/**
 * Systel Cuora 2 (firma 0040, formato cuora2). Registros REALES leídos de la balanza de La cosa es con carne
 * (17/11/2026, función 3, 266 productos). Escritura según el protocolo oficial Cuora V4.0 (Rev 03/Dic/2010, pág. 8):
 * función 4 = lo mismo que la lectura + "Mantener totales" (N/M) después de la tara.
 */
const REAL: [number, string][] = [
  [17, "00171bola lomo         02050000000000017010000P000000N"],
  [18, "00181cuadrada          02050000000000018010000P000000N"],
  [19, "00191peceto            02600000000000019010000P000000N"],
  [22, "00221falda             01200000000000022010000P000000N"],
  [30, "00301lomo              02950000000000030080000P000000N"],
  [31, "00311costilla          02250000000000031080000P000000N"]
];

const noop = () => {};
const P = (id: string, code: string, name: string, priceRetail: number, unit = "kg"): EngineProduct => ({ id, code, name, unit, priceRetail });
// Patagonia del cliente: en la balanza, 17/18/22/30 tienen OTRO producto; 19 es el mismo con otro precio; 1 no está.
const PRODUCTS = [
  P("p1", "1", "ASADO", 22500),
  P("p17", "17", "CUADRADA", 20500),
  P("p18", "18", "PICANHA", 20000),
  P("p19", "19", "PECETO", 27000),
  P("p22", "22", "BRAZUELO S/H", 17500),
  P("p30", "30", "HAMMER", 19000),
  P("p5000", "5000", "MAS ALLA DEL TOPE", 1000)
];

function cuora2() {
  const f = new FakeCuora("cuora2", { address: 20, protocol: "0040", capacity: 4000 });
  for (const [n, raw] of REAL) f.plus.set(n, raw);
  return f;
}

function fakeDb() {
  const calls: { catalog?: { code: number; eanType: number | null; eanConfig: string | null }[] } = {};
  const deps: SystelDeps = {
    loadSetup: async () => null,
    saveCatalog: async (_b, _p, catalog) => void (calls.catalog = catalog.map((c) => ({ code: c.code, eanType: c.eanType, eanConfig: c.eanConfig }))),
    setLinks: async () => {},
    setActive: async () => {},
    saveLocalBackup: () => {}
  };
  return { deps, calls };
}
const ctx = (products = PRODUCTS): EngineContext => ({ branchId: "b1", products, online: true });
const writes = (f: FakeCuora) => f.received.filter((r) => r.fn === 4);
const writeTo = (f: FakeCuora, n: number) => writes(f).filter((r) => Number(r.data.slice(0, 4)) === n);

beforeEach(() => installFakeLocalStorage());

describe("[SIMULADO, registros REALES] Systel Cuora 2: Patagonia → balanza", () => {
  it("el armado de la función 4 es la lectura + N/M después de la tara (V4.0 pág. 8)", () => {
    const read = REAL[0][1];
    const data = cuora2WriteData(read, true);
    assert.equal(data.length, 55);
    assert.equal(data[CUORA2_FIXED], "M");
    assert.equal(data[4], "1", "versión 1 = gestionado desde la PC");
    assert.equal(data.slice(0, CUORA2_FIXED) + data.slice(CUORA2_FIXED + 1), read);
  });

  it("prepara: ya no es un modelo que solo se lee; los números ocupados quedan para reemplazar", async () => {
    const { deps } = fakeDb();
    const prep = await new SystelSession(cuora2(), 20, ctx(), deps).prepare(noop);
    assert.equal(prep.label, "Systel Cuora 2");
    assert.equal(prep.canWrite, true);
    assert.equal(prep.blocker, undefined);
    assert.equal(prep.upToDate, false);
    assert.equal(prep.writes, 2, "1 ASADO nuevo + 19 PECETO con precio nuevo");
    assert.deepEqual(prep.pending.map((x) => x.code).sort((a, b) => a - b), [17, 18, 22, 30]);
    assert.ok(prep.skipped.some((x) => x.code === "5000"), "la balanza tiene 4000 lugares: el 5000 no va");
  });

  it("sincroniza: prueba en un número libre, después cada producto releído; N para nuevo, M para el mismo producto", async () => {
    const f = cuora2();
    const { deps, calls } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, true, out.message);
    // La prueba va primero, en el número libre más alto que informa la balanza (4000).
    assert.equal(Number(writes(f)[0].data.slice(0, 4)), 4000);
    assert.equal(parsePluAs("cuora2", f.plus.get(4000)!)!.name.trim(), PROOF_NAME);
    const asado = parsePluAs("cuora2", f.plus.get(1)!)!;
    assert.equal(asado.name.trim(), "ASADO");
    assert.equal(asado.prices[0], 22500);
    assert.equal(asado.code, 1);
    assert.equal(asado.saleType, "P");
    assert.equal(writeTo(f, 1)[0].data[CUORA2_FIXED], "N", "producto nuevo: totales en cero");
    const peceto = parsePluAs("cuora2", f.plus.get(19)!)!;
    assert.equal(peceto.prices[0], 27000);
    assert.equal(writeTo(f, 19)[0].data[CUORA2_FIXED], "M", "mismo producto: conserva los totales de venta");
    // Lo ocupado sin autorización, y lo que Patagonia no tiene, no se tocan.
    for (const n of [17, 18, 22, 30, 31]) assert.equal(f.plus.get(n), REAL.find((r) => r[0] === n)![1]);
    // Mostrador lee la etiqueta con el formato general de la balanza (la Cuora 2 no tiene código por producto).
    assert.ok(calls.catalog!.length > 0);
    assert.ok(calls.catalog!.every((c) => c.eanType === 0 && c.eanConfig === null));
  });

  it("con \"Reemplazarlos\", el número ocupado pasa a ser el producto de Patagonia, con totales en cero", async () => {
    const f = cuora2();
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    const out = await s.sync(await s.prepare(noop), noop, { allowReplace: true });
    assert.equal(out.ok, true, out.message);
    assert.equal(out.pending.length, 0);
    const c17 = parsePluAs("cuora2", f.plus.get(17)!)!;
    assert.equal(c17.name.trim(), "CUADRADA");
    assert.equal(c17.prices[0], 20500);
    assert.equal(writeTo(f, 17)[0].data[CUORA2_FIXED], "N");
    assert.equal(parsePluAs("cuora2", f.plus.get(30)!)!.name.trim(), "HAMMER");
    assert.equal(f.plus.get(31), REAL[5][1], "lo que Patagonia no tiene no se toca");
  });

  it("si la prueba no se relee igual, frena sin tocar ningún producto del cliente", async () => {
    const f = cuora2();
    f.corruptAfterWrite = 4000;
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx(), deps);
    const out = await s.sync(await s.prepare(noop), noop, { allowReplace: true });
    assert.equal(out.ok, false);
    assert.ok(writes(f).every((w) => Number(w.data.slice(0, 4)) === 4000), "solo se escribió el número de prueba");
    for (const [n, raw] of REAL) assert.equal(f.plus.get(n), raw);
    assert.equal(f.plus.get(1), undefined);
  });

  it("si un producto no se relee igual, lo vuelve a dejar como estaba (con M, sin borrar totales) y frena", async () => {
    const f = cuora2();
    f.corruptAfterWrite = 19;
    f.corruptOnce = true;
    const { deps } = fakeDb();
    const s = new SystelSession(f, 20, ctx([P("p19", "19", "PECETO", 27000)]), deps);
    const out = await s.sync(await s.prepare(noop), noop);
    assert.equal(out.ok, false);
    assert.equal(f.plus.get(19), REAL[2][1], "restaurado");
    const last = writeTo(f, 19).at(-1)!;
    assert.equal(last.data[CUORA2_FIXED], "M");
  });

  it("la segunda vez, sin cambios en Patagonia, queda al día sin escribir nada", async () => {
    const f = cuora2();
    const { deps } = fakeDb();
    const one = [P("p19", "19", "PECETO", 27000)];
    const s = new SystelSession(f, 20, ctx(one), deps);
    assert.equal((await s.sync(await s.prepare(noop), noop)).ok, true);
    const before = writes(f).length;
    const again = await new SystelSession(f, 20, ctx(one), deps).prepare(noop);
    assert.equal(again.writes, 0);
    assert.equal(again.ready, 1);
    assert.equal(writes(f).length, before);
  });
});
