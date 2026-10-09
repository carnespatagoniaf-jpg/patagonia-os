import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { takeSystelBackup } from "./systel-backup";
import { assertSystelFunctionAllowed, SystelClient, SYSTEL_READ_FUNCTIONS, SYSTEL_WRITE_FUNCTIONS } from "./systel-client";
import { buildCuoraNeoCsv, buildQendraCsv } from "./systel-csv";
import { FakeCuora, fakeReadRecord } from "./systel-fake";
import { buildSystelFrame, parseSystelReply, toCuoraText, xorChecksum } from "./systel-frame";
import { buildNewPluData, detectPluLayouts, LAYOUT_INFO, parsePluList, parseSignature, priceToRaw, type SystelLayout } from "./systel-plu";
import { planSystelSync, runSystelSync } from "./systel-sync";
import { parseCuoraWeight, parseWeightReply } from "./systel-weight";
import { runSystelWriteTest } from "./systel-write-test";

const LAYOUTS: SystelLayout[] = ["cuora2", "max60", "max62", "max7"];

function loadedFake(layout: SystelLayout, options: ConstructorParameters<typeof FakeCuora>[1] = {}) {
  const fake = new FakeCuora(layout, options);
  fake.plus.set(1, fakeReadRecord(layout, { number: 1, name: "NALGA", price: 18500, code: 1, type: "P" }));
  fake.plus.set(2, fakeReadRecord(layout, { number: 2, name: "HAMBURGUESA X4", price: 4200, code: 2, type: "U" }));
  fake.plus.set(7, fakeReadRecord(layout, { number: 7, name: "MILANESA", price: 9800, code: 777, type: "P", tare: 15 }));
  return fake;
}

const allowed = new Set<number>([...SYSTEL_READ_FUNCTIONS, ...SYSTEL_WRITE_FUNCTIONS]);

describe("trama Systel (documento oficial + programa de ejemplo)", () => {
  it("dirección y función en binario, datos ASCII, verificación = XOR de todo", () => {
    assert.deepEqual([...buildSystelFrame(1, 23)], [1, 23, 1 ^ 23]);
    const f = buildSystelFrame(5, 62, "000012");
    assert.equal(f[f.length - 1], xorChecksum(f.subarray(0, f.length - 1)));
    assert.equal(f.length, 2 + 6 + 1);
    assert.equal(buildSystelFrame(5, 61, "AB", { checksum: false }).length, 4);
  });

  it("reconoce ACK, errores E1-E9 y verificación mal", () => {
    const ack = parseSystelReply(Uint8Array.from([1, 33, 65, 67, 75, 1 ^ 33 ^ 65 ^ 67 ^ 75]))!;
    assert.equal(ack.kind, "ack");
    assert.ok(ack.checksumOk);
    const e7 = parseSystelReply(Uint8Array.from([1, 62, 69, 55, 1 ^ 62 ^ 69 ^ 55]))!;
    assert.equal(e7.kind, "error");
    assert.equal(e7.errorCode, "E7");
    assert.equal(parseSystelReply(Uint8Array.from([1, 62, 69, 55, 0]))!.checksumOk, false);
  });

  it("textos: sin acentos ni ñ, 18 caracteres", () => {
    assert.equal(toCuoraText("Ñandú asado; especial", 18), "Nandu asado, espec");
    assert.equal(toCuoraText("Pollo", 18).length, 18);
  });

  it("bloquea las funciones peligrosas (borrar, apagar, cierre, configuración)", () => {
    for (const fn of [5, 9, 26, 32, 42, 35, 8, 7]) assert.throws(() => assertSystelFunctionAllowed(fn), /Bloqueado/);
    assert.throws(() => assertSystelFunctionAllowed(33), /Bloqueado/, "escribir solo por changePrice/createPlu");
    assert.throws(() => assertSystelFunctionAllowed(61), /Bloqueado/);
    assert.doesNotThrow(() => assertSystelFunctionAllowed(62));
  });
});

describe("formatos de producto", () => {
  it("cada formato tiene un largo de lectura distinto y se reconoce solo", () => {
    const lengths = LAYOUTS.map((l) => fakeReadRecord(l, { number: 1, name: "X", price: 1, code: 1, type: "P" }).length);
    assert.deepEqual(lengths, [54, 156, 159, 223]);
    for (const l of LAYOUTS) {
      const found = detectPluLayouts(fakeReadRecord(l, { number: 12, name: "PECETO", price: 21000, code: 12, type: "P" }), 12);
      assert.equal(found.length, 1);
      assert.equal(found[0].layout, l);
      assert.equal(found[0].prices[0], 21000);
      assert.equal(found[0].name.trim(), "PECETO");
    }
  });

  it("el alta lleva el mismo largo que la lectura (menos la letra de gestión; Cuora 2: + letra N/M)", () => {
    const input = { number: 9, name: "Prueba", code: 9, saleType: "U" as const, priceRaw: 1500 };
    assert.equal(buildNewPluData("max7", input).length, 223 - 1);
    assert.equal(buildNewPluData("max62", input).length, 159 - 1);
    assert.equal(buildNewPluData("max60", input).length, 156 - 1);
    assert.equal(buildNewPluData("cuora2", input).length, 54 + 1);
  });

  it("lista de PLU (función 31) con 4 o 6 dígitos", () => {
    assert.deepEqual(parsePluList("N0001V0N0012V1F"), { entries: [{ number: 1, version: "0" }, { number: 12, version: "1" }], complete: true, digits: 4 });
    assert.equal(parsePluList("N000001V2F")!.digits, 6);
    assert.equal(parsePluList("N0001V0")?.entries, undefined, "sin F no está completa");
  });

  it("firma digital y decimales del precio", () => {
    assert.deepEqual(parseSignature("F0001C031000S0040P08000A060D2"), { productType: "0001", capacityGrams: 31000, protocolVersion: "0040", pluCapacity: 8000, shortcuts: 60, priceDecimals: 2 });
    assert.equal(priceToRaw(25000, 0), 25000);
    assert.equal(priceToRaw(25000, 2), null, "con centavos $25.000 no entra en 6 números");
    assert.equal(priceToRaw(1234.5, 2), 123450);
  });
});

describe("Cuora simulada: respaldo, cambio de precio, alta", () => {
  for (const layout of LAYOUTS) {
    it(`${layout}: respalda todo y reconoce el formato`, async () => {
      const fake = loadedFake(layout);
      const backup = await takeSystelBackup(new SystelClient(fake, { address: 1 }));
      assert.equal(backup.layout, layout);
      assert.equal(backup.complete, true);
      assert.equal(backup.plus.length, 3);
      assert.equal(backup.signature?.priceDecimals, 0);
      assert.ok(fake.received.every((r) => allowed.has(r.fn) && !SYSTEL_WRITE_FUNCTIONS.includes(r.fn as never)), "el respaldo solo lee");
    });

    it(`${layout}: el cambio de precio conserva código, tipo, tara y el resto`, async () => {
      const fake = loadedFake(layout);
      const client = new SystelClient(fake, { address: 1 });
      const before = (await client.readPlu(layout, 7))!;
      const out = await client.changePrice(before, 10500);
      assert.equal(out.ok, true, out.detail);
      assert.equal(out.readBack!.prices[0], 10500);
      assert.equal(out.readBack!.code, 777);
      assert.equal(out.readBack!.tareGrams, 15);
      assert.equal(out.readBack!.tail, before.tail);
    });

    it(`${layout}: crea un producto nuevo y no escribe encima de uno existente`, async () => {
      const fake = loadedFake(layout);
      const client = new SystelClient(fake, { address: 1 });
      const known = new Set([1, 2, 7]);
      const ok = await client.createPlu(layout, { number: 50, name: "Vacio", code: 50, saleType: "P", priceRaw: 16000 }, known);
      assert.equal(ok.ok, true, ok.detail);
      assert.equal(ok.readBack!.saleType, "P");
      const busy = await client.createPlu(layout, { number: 2, name: "Otro", code: 2, saleType: "U", priceRaw: 1 }, known);
      assert.equal(busy.verdict, "ocupado");
      assert.equal(fake.plus.get(2)!.includes("HAMBURGUESA"), true);
    });
  }

  it("si la balanza espera la escritura SIN verificación, contesta E5 y se reintenta sin (nada quedó grabado)", async () => {
    const fake = loadedFake("max7", { writeChecksum: false });
    const client = new SystelClient(fake, { address: 1 });
    const out = await client.createPlu("max7", { number: 60, name: "Pollo", code: 60, saleType: "P", priceRaw: 5200 }, new Set([1, 2, 7]));
    assert.equal(out.ok, true, out.detail);
    assert.equal(client.writeChecksum, "sin");
  });

  it("frena si la relectura no coincide o si la balanza no aplicó el precio", async () => {
    const fake = loadedFake("max7");
    fake.corruptAfterWrite = 61;
    const client = new SystelClient(fake, { address: 1 });
    const bad = await client.createPlu("max7", { number: 61, name: "Pollo", code: 61, saleType: "P", priceRaw: 5200 }, new Set([1, 2, 7]));
    assert.equal(bad.verdict, "diferencia");
    fake.ignorePriceChange = true;
    const before = (await client.readPlu("max7", 1))!;
    const same = await client.changePrice(before, 1);
    assert.equal(same.verdict, "sin_cambios");
  });

  it("sin respuesta a una escritura: relee en vez de reenviar", async () => {
    const fake = loadedFake("max62");
    const client = new SystelClient(fake, { address: 1 });
    const before = (await client.readPlu("max62", 1))!;
    fake.silent = true;
    const out = await client.changePrice(before, 19000);
    assert.equal(out.verdict, "sin_relectura");
    assert.equal(fake.received.filter((r) => r.fn === 33).length, 1, "no reenvió");
  });
});

describe("plan y envío desde Patagonia", () => {
  it("actualiza, crea, deja sin cambios, revisa y omite según corresponda", async () => {
    const fake = loadedFake("max7");
    const backup = await takeSystelBackup(new SystelClient(fake, { address: 1 }));
    const plan = planSystelSync(backup, [
      { code: "1", name: "Nalga", byWeight: true, price: 19000 },
      { code: "2", name: "Hamburguesa x4", byWeight: true, price: 4200 },
      { code: "7", name: "Milanesa", byWeight: true, price: 9800 },
      { code: "30", name: "Chorizo", byWeight: true, price: 9000 },
      { code: "ABC", name: "Sin número", byWeight: false, price: 10 },
      { code: "31", name: "Caro", byWeight: true, price: 1_500_000 }
    ]);
    assert.deepEqual(plan.map((p) => p.action), ["actualizar", "revisar", "revisar", "crear", "omitir", "omitir"]);
    assert.match(plan[1].reason, /por unidad/);
    assert.match(plan[2].reason, /otro código de barras/);
  });

  it("con precio en centavos, $25.000 no entra y no se manda", async () => {
    const fake = loadedFake("max7", { decimals: 2 });
    const backup = await takeSystelBackup(new SystelClient(fake, { address: 1 }));
    const plan = planSystelSync(backup, [{ code: "40", name: "Lomo", byWeight: true, price: 25000 }]);
    assert.equal(plan[0].action, "omitir");
    assert.match(plan[0].reason, /9\.999,99/);
  });

  it("manda solo lo planificado, con funciones permitidas, y los demás productos quedan iguales", async () => {
    const fake = loadedFake("max62");
    const client = new SystelClient(fake, { address: 1 });
    const backup = await takeSystelBackup(client);
    const untouched = fake.plus.get(7);
    const plan = planSystelSync(backup, [
      { code: "1", name: "Nalga", byWeight: true, price: 19000 },
      { code: "30", name: "Chorizo", byWeight: true, price: 9000 },
      { code: "31", name: "Bife x unidad", byWeight: false, price: 3500 }
    ]);
    const res = await runSystelSync(client, "max62", plan);
    assert.equal(res.stoppedAt, null, JSON.stringify(res.stoppedAt));
    assert.equal(res.done.length, 3);
    assert.equal(fake.plus.get(7), untouched);
    assert.ok(fake.received.every((r) => allowed.has(r.fn)));
    assert.equal(detectPluLayouts(fake.plus.get(31)!, 31, ["max62"])[0].saleType, "U");
  });

  it("si un PLU cambió en la balanza después del respaldo, frena", async () => {
    const fake = loadedFake("max7");
    const client = new SystelClient(fake, { address: 1 });
    const backup = await takeSystelBackup(client);
    fake.plus.set(1, fakeReadRecord("max7", { number: 1, name: "NALGA CAMBIADA", price: 18500, code: 1, type: "P" }));
    const res = await runSystelSync(client, "max7", planSystelSync(backup, [{ code: "1", name: "Nalga", byWeight: true, price: 19000 }]));
    assert.equal(res.stoppedAt?.outcome.verdict, "diferencia");
  });
});

describe("prueba controlada (una sola visita)", () => {
  for (const layout of LAYOUTS) {
    it(`${layout}: crea 2 de prueba en números libres, cambia un precio y los del cliente quedan idénticos`, async () => {
      const fake = loadedFake(layout);
      const before = new Map(fake.plus);
      const res = await runSystelWriteTest(new SystelClient(fake, { address: 1 }));
      assert.equal(res.verdict, "ok", res.detail);
      assert.equal(res.testNumbers.length, 2);
      for (const [n, rec] of before) assert.equal(fake.plus.get(n), rec);
      assert.ok(fake.received.every((r) => allowed.has(r.fn)));
    });
  }

  it("sin respuesta de la balanza no escribe nada", async () => {
    const fake = loadedFake("max7");
    fake.silent = true;
    const res = await runSystelWriteTest(new SystelClient(fake, { address: 1 }));
    assert.equal(res.verdict, "sin_respaldo");
    assert.ok(fake.received.every((r) => !SYSTEL_WRITE_FUNCTIONS.includes(r.fn as never)));
  });
});

describe("archivos para Qendra y Cuora Neo", () => {
  it("Qendra: 9 campos con ;, sin encabezado, coma decimal, PESO/UNIDAD", () => {
    const { csv, skipped } = buildQendraCsv([
      { code: "1", name: "Nalga", byWeight: true, price: 18500, section: "Carnicería" },
      { code: "2", name: "Hamburguesa x4", byWeight: false, price: 4200.5 },
      { code: "9001", name: "Fuera de rango", byWeight: true, price: 1 }
    ]);
    assert.equal(csv, "Carniceria;1;Nalga;1;18500,00;0,00;PESO;0;\r\nGeneral;2;Hamburguesa x4;2;4200,50;0,00;UNIDAD;0;\r\n");
    assert.equal(skipped.length, 1);
  });

  it("Qendra: un producto sin precio NO va al archivo (la balanza quedaría en $0)", () => {
    const { csv, skipped } = buildQendraCsv([
      { code: "1", name: "Pata muslo", byWeight: true, price: 0 },
      { code: "2", name: "Suprema", byWeight: true, price: 7900 }
    ]);
    assert.equal(csv, "General;2;Suprema;2;7900,00;0,00;PESO;0;\r\n");
    assert.deepEqual(skipped.map((s) => s.reason), ["no tiene precio cargado en Patagonia"]);
  });

  it("Cuora Neo: formato 1 (9 campos), punto decimal", () => {
    const { csv } = buildCuoraNeoCsv([{ code: "12", name: "Vacío", byWeight: true, price: 16000 }]);
    assert.equal(csv, "General;12;Vacio;12;16000.00;0.00;PESO;0;\r\n");
  });
});

describe("peso", () => {
  it("protocolo D (CAS) con el ejemplo del documento y protocolo A inestable", () => {
    const d = parseWeightReply("D", Uint8Array.from([0x02, 0x30, 0x31, 0x32, 0x33, 0x34, 0x0d]));
    assert.ok(d && d !== "inestable");
    assert.equal(d.display, "01234");
    assert.equal(d.hasDecimalPoint, false, "sin punto: hay que confirmar con el visor");
    assert.equal(parseWeightReply("A", Uint8Array.from([0x11])), "inestable");
    const body = [0x02, ...Array.from("00.710", (c) => c.charCodeAt(0)), 0x03];
    const a = parseWeightReply("A", Uint8Array.from([...body, xorChecksum(body)]));
    assert.ok(a && a !== "inestable" && a.kg === 0.71);
  });

  it("función 1 de la Cuora: gramos, estable/inestable y tara", () => {
    assert.deepEqual(parseCuoraWeight("000250e000000"), { grams: 250, stable: true, tareGrams: 0 });
    assert.deepEqual(parseCuoraWeight("-00250i000010"), { grams: -250, stable: false, tareGrams: 10 });
  });
});
