import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SystelClient } from "./systel-client";
import { FakeCuora } from "./systel-fake";
import { pluEanSetting } from "./systel-plu";
import { runStage1FreeSlot, runStage2OneProduct, runTestProductRewrite, testRecordFrom } from "./systel-barcode-write-test";
import { restoreFromBackup, takeProductBackup, writeDataFromRead } from "./systel-product-barcode";
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
  it("el registro de prueba es el de referencia con otro número, nombre de prueba y $1 (lista 2 en 0)", () => {
    const r = testRecordFrom(REAL_PLU_13_PECHUGA_SH, "max60", 7999)!;
    assert.equal(r.length, REAL_PLU_13_PECHUGA_SH.length);
    assert.equal(r.slice(0, 4), "7999");
    assert.equal(r.slice(5, 23), "PRUEBA PATAGONIA  ");
    assert.equal(r.slice(23, 35), "000001000000");
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

describe("[SIMULADO] protecciones agregadas en la fase 0", () => {
  it("la prueba 2 no se hace sobre un producto con ventas en 40 días (sus acumulados no se pueden leer)", async () => {
    const f = scale("binario");
    f.sales.push({ date: "13/10/26", text: "000003096^13/10/26^12:58:32^02^0002^01^0001^00000^00000^000007200000" });
    const before = f.plus.get(2);
    const r = await runStage2OneProduct(client(f), "max60", { number: 2, saleType: "U", mode: "binario", protect, today });
    assert.equal(r.verdict, "frenado");
    assert.match(r.steps.at(-1)!.detail, /tiene ventas/);
    assert.equal(f.plus.get(2), before);
    assert.equal(f.received.filter((x) => x.fn === 61).length, 0);
  });
  it("restauración en una balanza que solo acepta el dígito: manda el respaldo con el dígito y queda igual", async () => {
    const f = scale("ascii");
    const c = client(f);
    const { backup } = await takeProductBackup(c, "max60", [2, 6]);
    await runStage2OneProduct(c, "max60", { number: 6, saleType: "P", mode: "ascii", protect, today });
    assert.deepEqual(pluEanSetting(f.plus.get(6)!), { type: 1, config: "20PPPPCCCCCC" });
    const r = await restoreFromBackup(c, backup, undefined, "ascii");
    assert.deepEqual(r.map((x) => x.verdict), ["igual", "restaurado"]);
    assert.deepEqual(pluEanSetting(f.plus.get(6)!), { type: 1, config: "000000000000" });
  });
  it("con la forma equivocada la balanza rechaza la restauración y se informa (no queda nada a medias)", async () => {
    const f = scale("ascii");
    const c = client(f);
    const { backup } = await takeProductBackup(c, "max60", [6]);
    await runStage2OneProduct(c, "max60", { number: 6, saleType: "P", mode: "ascii", protect, today });
    const r = await restoreFromBackup(c, backup, undefined, "binario");
    assert.deepEqual(r.map((x) => x.verdict), ["no_restaurado"]);
  });
  it("un cliente sin permiso de escritura nunca manda la 61, ni siquiera para restaurar", async () => {
    const f = scale("binario");
    const c = client(f, false);
    const { backup } = await takeProductBackup(c, "max60", [6]);
    f.plus.set(6, f.plus.get(6)!.replace("TROZADITO", "TROZXDITO"));
    const r = await restoreFromBackup(c, backup);
    assert.deepEqual(r.map((x) => x.verdict), ["bloqueado"]);
    assert.equal(f.received.filter((x) => x.fn === 61).length, 0);
  });
  it("la escritura de datos para restaurar: igual al respaldo sin la gestión; con el dígito si hace falta", () => {
    const d = writeDataFromRead(REAL_PLU_2_GRINGO_CAJON, "max60", "binario");
    assert.equal(d, REAL_PLU_2_GRINGO_CAJON.slice(0, 4) + REAL_PLU_2_GRINGO_CAJON.slice(5));
    assert.ok(writeDataFromRead(REAL_PLU_2_GRINGO_CAJON, "max60", "ascii").endsWith("1000000000000N"));
  });
});

describe("[SIMULADO] sesión única: dos productos de prueba y reescritura de prueba", () => {
  it("crea un producto de prueba por peso (7999) y otro por unidad (7998); los del cliente iguales", async () => {
    const f = scale("ascii");
    const r = await runStage1FreeSlot(client(f), "max60", { templateNumber: 13, unitTemplateNumber: 2, protect, today });
    assert.equal(r.verdict, "confirmado", JSON.stringify(r.steps));
    assert.deepEqual([r.number, r.unitNumber, r.mode], [7999, 7998, "ascii"]);
    assert.deepEqual(pluEanSetting(f.plus.get(7999)!), { type: 1, config: "20PPPPCCCCCC" });
    assert.deepEqual(pluEanSetting(f.plus.get(7998)!), { type: 1, config: "21PPPPCCCCCC" });
    assert.equal(f.plus.get(7998)![f.plus.get(7998)!.length - 15 - 40] !== undefined, true);
    assert.equal(f.plus.get(2), REAL_PLU_2_GRINGO_CAJON);
  });
  it("la reescritura de prueba solo acepta un producto \"PRUEBA PATAGONIA\"", async () => {
    const f = scale("binario");
    const c = client(f);
    await runStage1FreeSlot(c, "max60", { templateNumber: 13, protect, today });
    const ok = await runTestProductRewrite(c, "max60", { number: 7999, mode: "binario", protect });
    assert.equal(ok.verdict, "confirmado", JSON.stringify(ok.steps));
    const before2 = f.plus.get(2);
    const n61 = f.received.filter((x) => x.fn === 61).length;
    const no = await runTestProductRewrite(c, "max60", { number: 2, mode: "binario", protect });
    assert.equal(no.verdict, "frenado");
    assert.equal(f.plus.get(2), before2);
    assert.equal(f.received.filter((x) => x.fn === 61).length, n61);
  });
});

describe("[REAL 14/10] la Cuora de Los gringos guarda el tipo con bits altos (0x01 → 0xD1)", () => {
  it("prueba 1, 1b, 2, todos y restaurar funcionan igual con una balanza que devuelve 0xD1", async () => {
    const f = new FakeCuora("max60", { address: 20, typeByteAccepted: "binario", typeHighBits: 0xd0 });
    f.plus.set(2, REAL_PLU_2_GRINGO_CAJON);
    f.plus.set(13, REAL_PLU_13_PECHUGA_SH);
    f.plus.set(6, REAL_PLU_13_PECHUGA_SH.replace(/^0013/, "0006").replace("PECHUGA S/H x1x3  ", "TROZADITOx5       ").replace("\u000120PPPPCCCCCC", "\u0001000000000000"));
    f.sales.push({ date: "13/10/26", text: "000003095^13/10/26^12:55:34^02^0005^01^0000^00215^00000^000000111800" });
    const c = client(f);
    const s1 = await runStage1FreeSlot(c, "max60", { templateNumber: 13, unitTemplateNumber: 2, protect, today });
    assert.equal(s1.verdict, "confirmado", JSON.stringify(s1.steps));
    assert.equal(f.plus.get(7999)!.charCodeAt(f.plus.get(7999)!.length - 14), 0xd1);
    assert.deepEqual(pluEanSetting(f.plus.get(7999)!), { type: 1, config: "20PPPPCCCCCC" });
    assert.equal((await runTestProductRewrite(c, "max60", { number: 7999, mode: "binario", protect })).verdict, "confirmado");
    const { backup } = await takeProductBackup(c, "max60", [2, 6, 13]);
    assert.equal((await runStage2OneProduct(c, "max60", { number: 6, saleType: "P", mode: "binario", protect, today })).verdict, "confirmado");
    assert.deepEqual(pluEanSetting(f.plus.get(6)!), { type: 1, config: "20PPPPCCCCCC" });
    // Restaurar un producto que la balanza guardó con 0xD1: se manda 0x01 (nunca 0xD1) y vuelve a como estaba.
    const r = await restoreFromBackup(c, backup, [6], "binario");
    assert.deepEqual(r.map((x) => x.verdict), ["restaurado"]);
    assert.deepEqual(pluEanSetting(f.plus.get(6)!), { type: 1, config: "000000000000" });
  });
});
