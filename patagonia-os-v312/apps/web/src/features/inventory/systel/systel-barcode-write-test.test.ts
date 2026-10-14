import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SystelClient } from "./systel-client";
import { FakeCuora } from "./systel-fake";
import { pluEanSetting } from "./systel-plu";
import { runStage1FreeSlot, runStage2OneProduct, testRecordFrom } from "./systel-barcode-write-test";
import { REAL_PLU_13_PECHUGA_SH, REAL_PLU_2_GRINGO_CAJON } from "../../sale/systel-real-plu-records";

// [SIMULADO con registros REALES de Los gringos] La balanza real decide; esto prueba que la herramienta frena bien.
const today = new Date(2026, 9, 15);
function scale(typeByteAccepted?: "binario" | "ascii") {
  const f = new FakeCuora("max60", { address: 20, typeByteAccepted });
  f.plus.set(2, REAL_PLU_2_GRINGO_CAJON);
  f.plus.set(13, REAL_PLU_13_PECHUGA_SH);
  f.plus.set(6, REAL_PLU_13_PECHUGA_SH.replace(/^0013/, "0006").replace("PECHUGA S/H x1x3  ", "TROZADITOx5       ").replace("\u000120PPPPCCCCCC", "\u0001000000000000"));
  f.sales.push({ date: "13/10/26", text: "000003095^13/10/26^12:55:34^02^0005^01^0000^00215^00000^000000111800" });
  return f;
}
const client = (f: FakeCuora, write = true) => new SystelClient(f, { address: 20, busyRetryMs: [], writes: { productBarcode: write } });
const protect = [2, 13, 6];

describe("[SIMULADO] prueba de escritura, etapa 1: número libre", () => {
  it("el registro de prueba es el de referencia con otro número, nombre de prueba y sin precios", () => {
    const r = testRecordFrom(REAL_PLU_13_PECHUGA_SH, "max60", 7999)!;
    assert.equal(r.length, REAL_PLU_13_PECHUGA_SH.length);
    assert.equal(r.slice(0, 4), "7999");
    assert.equal(r.slice(5, 23), "PRUEBA PATAGONIA  ");
    assert.equal(r.slice(23, 35), "000000000000");
    assert.equal(r.slice(35, 40), "07999");
    assert.equal(r.slice(40), REAL_PLU_13_PECHUGA_SH.slice(40));
  });
  it("balanza que acepta el tipo como byte: confirmado al primer intento, nada más cambió", async () => {
    const f = scale("binario");
    const r = await runStage1FreeSlot(client(f), "max60", { templateNumber: 13, protect, today });
    assert.equal(r.verdict, "confirmado", JSON.stringify(r.steps));
    assert.equal(r.mode, "binario");
    assert.equal(r.number, 7999);
    assert.deepEqual(pluEanSetting(f.plus.get(7999)!), { type: 1, config: "20PPPPCCCCCC" });
    assert.equal(f.plus.get(2), REAL_PLU_2_GRINGO_CAJON);
    assert.equal(r.salesBefore, r.salesAfter);
    // Solo una escritura (61), sobre el número libre; el resto son lecturas.
    assert.deepEqual(f.received.filter((x) => x.fn === 61).length, 1);
    assert.ok(f.received.every((x) => [23, 61, 62, 72].includes(x.fn)));
  });
  it("balanza que acepta el tipo como dígito: rechaza la primera (E8, no guarda nada) y confirma la segunda", async () => {
    const f = scale("ascii");
    const r = await runStage1FreeSlot(client(f), "max60", { templateNumber: 13, protect, today });
    assert.equal(r.verdict, "confirmado", JSON.stringify(r.steps));
    assert.equal(r.mode, "ascii");
    assert.equal(f.received.filter((x) => x.fn === 61).length, 2);
  });
  it("si el número candidato está ocupado, sigue con el siguiente; nunca escribe sobre un producto existente", async () => {
    const f = scale("binario");
    f.plus.set(7999, REAL_PLU_2_GRINGO_CAJON.replace(/^0002/, "7999"));
    const before = f.plus.get(7999);
    const r = await runStage1FreeSlot(client(f), "max60", { templateNumber: 13, protect, today });
    assert.equal(r.number, 7998);
    assert.equal(f.plus.get(7999), before);
  });
  it("sin autorización (escritura bloqueada) no manda ninguna escritura", async () => {
    const f = scale("binario");
    const r = await runStage1FreeSlot(client(f, false), "max60", { templateNumber: 13, protect, today });
    assert.equal(r.verdict, "bloqueado");
    assert.equal(f.received.filter((x) => x.fn === 61).length, 0);
  });
  it("sin reporte de ventas legible no empieza (no habría cómo comprobar que no cambió)", async () => {
    const f = scale("binario");
    f.salesEndExclusive = false;
    f.sales = [];
    const r = await runStage1FreeSlot(client(f), "max60", { templateNumber: 13, protect, today });
    assert.equal(r.verdict, "frenado");
    assert.equal(f.received.filter((x) => x.fn === 61).length, 0);
  });
});

describe("[SIMULADO] prueba de escritura, etapa 2: un producto real sin ventas", () => {
  it("TROZADITO x5 (6): solo cambia su código; los otros productos y las ventas iguales", async () => {
    const f = scale("binario");
    const r = await runStage2OneProduct(client(f), "max60", { number: 6, saleType: "P", mode: "binario", protect, today });
    assert.equal(r.verdict, "confirmado", JSON.stringify(r.steps));
    assert.deepEqual(pluEanSetting(f.plus.get(6)!), { type: 1, config: "20PPPPCCCCCC" });
    assert.equal(f.plus.get(2), REAL_PLU_2_GRINGO_CAJON);
    assert.equal(f.plus.get(13), REAL_PLU_13_PECHUGA_SH);
  });
  it("si la balanza cambiara otra cosa, restaura el producto y frena", async () => {
    const f = scale("binario");
    f.corruptAfterWrite = 6;
    f.corruptOnce = true;
    const before = f.plus.get(6);
    const r = await runStage2OneProduct(client(f), "max60", { number: 6, saleType: "P", mode: "binario", protect, today });
    assert.equal(r.verdict, "frenado");
    assert.equal(r.rewrite?.verdict, "diferencia_restaurado");
    assert.equal(f.plus.get(6)?.slice(5), before?.slice(5));
  });
});
