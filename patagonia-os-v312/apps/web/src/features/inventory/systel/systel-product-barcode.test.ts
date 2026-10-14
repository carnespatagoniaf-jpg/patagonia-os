import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SystelClient } from "./systel-client";
import { FakeCuora } from "./systel-fake";
import { pluEanSetting } from "./systel-plu";
import { buildBarcodeRewrite, compareWithBackup, onlyBarcodeChanged, restoreFromBackup, rewriteAllProductBarcodes, rewriteProductBarcode, takeProductBackup, verifyBackup } from "./systel-product-barcode";
import { REAL_PLU_13_PECHUGA_SH, REAL_PLU_2_GRINGO_CAJON } from "../../sale/systel-real-plu-records";

// [SIMULADO] Cuora que guarda y devuelve los registros REALES de Los gringos (14/10).
// Un producto de "formato general" (tipo 0): el registro real del 13 con el byte del tipo en 0x00 (así lo informó
// la balanza para sus productos 86 a 97, que no leímos byte a byte en este archivo).
const TYPE0 = REAL_PLU_13_PECHUGA_SH.slice(0, REAL_PLU_13_PECHUGA_SH.length - 14) + "\u0000" + REAL_PLU_13_PECHUGA_SH.slice(-13);

function scale() {
  const f = new FakeCuora("max60", { address: 20 });
  f.plus.set(2, REAL_PLU_2_GRINGO_CAJON);
  f.plus.set(13, REAL_PLU_13_PECHUGA_SH);
  f.plus.set(86, TYPE0.replace(/^0013/, "0086"));
  return f;
}
const client = (f: FakeCuora, write = true) => new SystelClient(f, { address: 20, busyRetryMs: [], writes: { productBarcode: write } });

describe("[SIMULADO con registros REALES] código de barras de cada producto, cambiado desde Patagonia", () => {
  it("la escritura es el registro leído SIN la gestión, con solo los 12 caracteres del código cambiados", () => {
    const data = buildBarcodeRewrite(REAL_PLU_2_GRINGO_CAJON, "max60", "21PPPPCCCCCC")!;
    assert.equal(data.length, REAL_PLU_2_GRINGO_CAJON.length - 1);
    assert.equal(data.slice(0, 4), "0002");
    assert.equal(data.slice(4, 22), "GRINGO CAJON DE   ");
    assert.equal(data.slice(22, 34), "072000068000"); // precios intactos
    assert.ok(data.endsWith("\u000121PPPPCCCCCCN"));
  });

  it("CAJON (2, unitario, código en ceros) → 21PPPPCCCCCC confirmado; todo lo demás igual", async () => {
    const f = scale();
    const r = await rewriteProductBarcode(client(f), "max60", 2, "U");
    assert.equal(r.verdict, "confirmado", r.detail);
    assert.deepEqual(pluEanSetting(f.plus.get(2)!), { type: 1, config: "21PPPPCCCCCC" });
    assert.ok(onlyBarcodeChanged(REAL_PLU_2_GRINGO_CAJON, f.plus.get(2)!, "max60"));
    assert.deepEqual(f.received.map((x) => x.fn), [62, 61, 62]);
  });

  it("PECHUGA S/H (13) ya tiene 20PPPPCCCCCC: no se escribe nada", async () => {
    const f = scale();
    const r = await rewriteProductBarcode(client(f), "max60", 13, "P");
    assert.equal(r.verdict, "ya_estaba");
    assert.deepEqual(f.received.map((x) => x.fn), [62]);
  });

  it("producto de formato general (tipo 0) → queda con su código propio 20PPPPCCCCCC (tipo 0x01, como los reales)", async () => {
    const f = scale();
    const r = await rewriteProductBarcode(client(f), "max60", 86, "P");
    assert.equal(r.verdict, "confirmado", r.detail);
    assert.deepEqual(pluEanSetting(f.plus.get(86)!), { type: 1, config: "20PPPPCCCCCC" });
  });

  it("la balanza rechaza (E5): no cambió nada y se informa", async () => {
    const f = scale();
    const orig = f.exchange.bind(f);
    f.exchange = async (frame: Uint8Array) => (frame[1] === 61 ? Uint8Array.from([20, 61, 0x45, 0x35, 20 ^ 61 ^ 0x45 ^ 0x35]) : orig(frame));
    const r = await rewriteProductBarcode(client(f), "max60", 2, "U");
    assert.equal(r.verdict, "rechazado");
    assert.equal(f.plus.get(2), REAL_PLU_2_GRINGO_CAJON);
  });

  it("si la balanza cambia OTRA cosa: se detecta, se intenta restaurar y se frena", async () => {
    const f = scale();
    f.corruptAfterWrite = 2;
    const r = await rewriteProductBarcode(client(f), "max60", 2, "U");
    assert.equal(r.ok, false);
    assert.match(r.verdict, /^diferencia/);
  });

  it("sin habilitar la escritura: bloqueado, no se manda la 61", async () => {
    const f = scale();
    const r = await rewriteProductBarcode(client(f, false), "max60", 2, "U");
    assert.equal(r.verdict, "bloqueado");
    assert.ok(!f.received.some((x) => x.fn === 61));
  });

  it("todos: primero el respaldo de TODOS, después de a uno; con límite 1 hace solo el primero", async () => {
    const f = scale();
    const r = await rewriteAllProductBarcodes(client(f), "max60", [{ number: 2, saleType: "U" }, { number: 86, saleType: "P" }, { number: 13, saleType: "P" }], { limit: 1 });
    assert.equal(r.backup.length, 3);
    assert.deepEqual(r.results.map((x) => [x.number, x.verdict]), [[2, "confirmado"]]);
    assert.equal(pluEanSetting(f.plus.get(86)!).type, 0); // el segundo no se tocó
  });
});

describe("[SIMULADO con registros REALES] respaldo, corte de conexión y restauración", () => {
  it("respaldo completo y verificable; si se toca un byte, la verificación falla", async () => {
    const f = scale();
    const { backup, missing } = await takeProductBackup(client(f, false), "max60", [2, 13, 86]);
    assert.deepEqual(missing, []);
    assert.equal(verifyBackup(backup).ok, true);
    // Solo lectura: no se mandó nada que no sea 62.
    assert.deepEqual([...new Set(f.received.map((x) => x.fn))], [62]);
    const tampered = { ...backup, records: backup.records.map((r, i) => (i === 0 ? { ...r, raw: r.raw.replace("GRINGO", "GRINGA") } : r)) };
    assert.equal(verifyBackup(tampered).ok, false);
  });

  it("se corta la conexión justo después de mandar la escritura: se sabe en qué quedó cada producto y se restaura", async () => {
    const f = scale();
    const c = client(f);
    const { backup } = await takeProductBackup(c, "max60", [2, 13, 86]);
    // La balanza aplica la escritura pero no llega la respuesta (y tampoco contesta la relectura).
    const orig = f.exchange.bind(f);
    let cut = false;
    f.exchange = async (frame: Uint8Array) => {
      if (cut) return null;
      const r = await orig(frame);
      if (frame[1] === 61) cut = true;
      return frame[1] === 61 ? null : r;
    };
    const r = await rewriteProductBarcode(c, "max60", 2, "U");
    assert.equal(r.ok, false);
    assert.equal(r.verdict, "indeterminado");
    // Vuelve la conexión: comparación SOLO LECTURA contra el respaldo.
    f.exchange = orig;
    assert.deepEqual(await compareWithBackup(c, backup), [{ number: 2, state: "solo_codigo" }, { number: 13, state: "igual" }, { number: 86, state: "igual" }]);
    // Restauración: el 2 vuelve a ser idéntico al respaldo; los otros no se tocan.
    assert.deepEqual(await restoreFromBackup(c, backup), [{ number: 2, verdict: "restaurado" }, { number: 13, verdict: "igual" }, { number: 86, verdict: "igual" }]);
    assert.deepEqual((await compareWithBackup(c, backup)).map((s) => s.state), ["igual", "igual", "igual"]);
  });

  it("la restauración también está bloqueada si la escritura no está habilitada", async () => {
    const f = scale();
    const { backup } = await takeProductBackup(client(f, false), "max60", [2]);
    f.plus.set(2, f.plus.get(2)!.replace("000000000000N", "21PPPPCCCCCCN"));
    assert.deepEqual(await restoreFromBackup(client(f, false), backup), [{ number: 2, verdict: "bloqueado" }]);
  });
});
