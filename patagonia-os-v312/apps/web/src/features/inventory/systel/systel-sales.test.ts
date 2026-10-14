import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Product } from "@patagonia/domain";
import { SystelClient } from "./systel-client";
import { FakeCuora, fakeReadRecord, fakeSaleLine } from "./systel-fake";
import { assignLineKeys, decodeSumCode, findTicketsForTotal, groupTickets, linkTicketLines, mostradorSalesRequest, parseSalesReport, salesReportRequest, type ScalePluInfo } from "./systel-sales";
import { readTicketDetail } from "./systel-ticket-detail";

const product = (code: string, name: string, unit: "kg" | "unit" | "box", priceRetail: number) =>
  ({ id: `id-${code}`, code, name, unit, priceRetail, cost: 0, stock: 0, minStock: 0, active: true }) as unknown as Product;

// Productos de Los gringos en Patagonia (13/10): el cajón y el trozadito con su precio; el 17 SIN precio
// (como 99 de sus 103 productos).
const GRINGOS = [product("2", "GRINGO CAJON DE POLLO", "unit", 72000), product("5", "TROZADITOx1x2", "kg", 5200), product("17", "ALITAS", "kg", 0)];

// Configuración REAL de la balanza de Los gringos (función 39, 09/10), con el formato de sumas que se
// ve en la pantalla de la balanza el 13/10 ("22AAIIIIIIII").
const REAL_CONFIG_AA = "Ton=2;Gris=0;Pap=0;APa=0;Vel=5;CPr=0;CAdm=01234;CCon=01234;Sinc=0;E_P=20PPPPCCCCCC;E_U=21PPPPCCCCCC;E_S=22AAIIIIIIII;CImp=2;Pub=LOS GRINGOS                    ;Enc1=NOMBRE DEL NEGOCIO;Enc2=Direccion - Telefono            ;PeP=3;SEt=S;ETi=S";
const REAL_CONFIG_BB = REAL_CONFIG_AA.replace("E_S=22AAIIIIIIII", "E_S=22BBIIIIIIII");

// [SIMULADO con los datos del ticket REAL] 13/10/2026 12:55:34, op. 20-3095: (2) GRINGO CAJON 1un $72.000
// + (5) TROZADITO 0,215 kg $1.118 = $73.118. El N.º de ticket (3095), vendedor (01) y sector en el
// reporte, y el número = código de cada PLU en la balanza, son SUPUESTOS: nunca se leyó una 72 ni una 62 reales.
const t3095 = [
  fakeSaleLine({ ticket: 3095, date: "13/10/26", time: "12:55:34", plu: 2, units: 1, amount: 72000 }),
  fakeSaleLine({ ticket: 3095, date: "13/10/26", time: "12:55:34", plu: 5, grams: 215, amount: 1118 })
];
// Otro ticket DISTINTO con el mismo total y la misma cantidad de artículos.
const t3101 = [
  fakeSaleLine({ ticket: 3101, date: "13/10/26", time: "13:20:10", plu: 2, units: 1, amount: 72000 }),
  fakeSaleLine({ ticket: 3101, date: "13/10/26", time: "13:20:11", plu: 5, grams: 215, amount: 1118 })
];
const DAY = new Date(2026, 9, 13, 13, 30);
const TOTAL_CODE = "2202000731184"; // REAL

function scale(sales = t3095, config = REAL_CONFIG_AA) {
  const fake = new FakeCuora("max60", { address: 20 });
  fake.config = config;
  fake.plus.set(2, fakeReadRecord("max60", { number: 2, name: "GRINGO CAJON DE", price: 72000, code: 2, type: "U" }));
  fake.plus.set(5, fakeReadRecord("max60", { number: 5, name: "TROZADITOx1x2", price: 5200, code: 5, type: "P" }));
  fake.plus.set(17, fakeReadRecord("max60", { number: 17, name: "ALITAS", price: 4500, code: 17, type: "P" }));
  fake.sales = sales;
  return fake;
}
const read = (fake: FakeCuora, extra: Partial<Parameters<typeof readTicketDetail>[1]> = {}) =>
  readTicketDetail(new SystelClient(fake, { address: 20, busyRetryMs: [1, 1, 1] }), { code: TOTAL_CODE, amount: 73118, products: GRINGOS, usedKeys: [], now: DAY, ...extra });

describe("reporte de ventas de la Systel (función 72, solo lectura): formato", () => {
  it("[REAL 14/10] pedido: día-mes-año de inicio y de fin SIN INCLUIR (hoy a hoy da E7 en la balanza real)", () => {
    assert.equal(salesReportRequest(DAY), "131026141026");
    assert.equal(mostradorSalesRequest(DAY), "121026141026");
  });
  it("con o sin \"^\" entre artículos; lo que no coincide con el documento se rechaza entero", () => {
    for (const sep of ["^", ""]) assert.equal(parseSalesReport(t3095.map((l) => l.text).join(sep) + "F").lines.length, 2);
    assert.equal(parseSalesReport(t3095[0].text).ok, false);
    assert.equal(parseSalesReport(t3095[0].text.replace("^000002^", "^2^") + "F").ok, false);
  });
});

describe("el código del TOTAL según el formato de sumas de la balanza (configuración real)", () => {
  it("[REAL] 2202000731184 con 22AAIIIIIIII = 2 artículos, $73.118", () => {
    assert.deepEqual(decodeSumCode(TOTAL_CODE, "22AAIIIIIIII"), { ok: true, amount: 73118, articles: 2, scale: null });
  });
  it("[REAL] 2220000012225 con 22BBIIIIIIII (09/10) = balanza 20, $1.222", () => {
    assert.deepEqual(decodeSumCode("2220000012225", "22BBIIIIIIII"), { ok: true, amount: 1222, articles: null, scale: 20 });
  });
});

describe("1 y 2: identidad por ARTÍCULO, no por importe ni por código del TOTAL", () => {
  const lines = assignLineKeys(parseSalesReport([...t3095, ...t3101].map((l) => l.text).join("^") + "F").lines, 20);
  it("dos tickets distintos con el mismo total y la misma cantidad de artículos: devuelve LOS DOS (no elige)", () => {
    const m = findTicketsForTotal(lines, 73118, { articles: 2 });
    assert.ok(m.ok);
    assert.deepEqual(m.candidates.map((t) => t.ticketId), ["3101", "3095"]);
  });
  it("cobrados los artículos de uno, el otro con el mismo total se puede cobrar, y el cobrado se informa", () => {
    const used = lines.filter((l) => Number(l.ticketId) === 3095).map((l) => l.key!);
    const m = findTicketsForTotal(lines, 73118, { articles: 2, usedKeys: used });
    assert.ok(m.ok);
    assert.deepEqual(m.candidates.map((t) => t.ticketId), ["3101"]);
    assert.deepEqual(m.charged.map((t) => t.ticketId), ["3095"]);
  });
  it("la identidad de cada artículo: balanza + fecha + N.º + vendedor + hora + PLU + orden", () => {
    assert.deepEqual(lines.filter((l) => Number(l.ticketId) === 3095).map((l) => l.key), ["systel:20:13/10/26:3095:01:12:55:34:2:1", "systel:20:13/10/26:3095:01:12:55:34:5:1"]);
  });
});

describe("numeración POR ARTÍCULO (como el \"Detalle de ventas\" impreso del manual: VENTA Nº38, Nº39…)", () => {
  // Mismo ticket real, pero con un N.º por artículo: cajón = 38, trozadito = 39.
  const perItem = [
    fakeSaleLine({ ticket: 37, date: "13/10/26", time: "12:40:00", plu: 5, grams: 300, amount: 1560 }),
    fakeSaleLine({ ticket: 38, date: "13/10/26", time: "12:55:20", plu: 2, units: 1, amount: 72000 }),
    fakeSaleLine({ ticket: 39, date: "13/10/26", time: "12:55:34", plu: 5, grams: 215, amount: 1118 }),
    fakeSaleLine({ ticket: 40, date: "13/10/26", time: "12:58:00", seller: 2, plu: 5, grams: 215, amount: 1118 })
  ];
  const lines = assignLineKeys(parseSalesReport(perItem.map((l) => l.text).join("^") + "F").lines, 20);
  it("encuentra el ticket de 2 artículos con N.º consecutivos del mismo vendedor que suman el total", () => {
    const m = findTicketsForTotal(lines, 73118, { articles: 2 });
    assert.ok(m.ok);
    assert.deepEqual(m.candidates.map((t) => [t.ticketId, t.lines.map((l) => l.plu)]), [["38-39", [2, 5]]]);
  });
  it("no junta artículos de otro vendedor ni N.º salteados", () => {
    // 39 (vendedor 1) + 40 (vendedor 2) no forman un ticket; 37 y 39 no son consecutivos.
    assert.equal(findTicketsForTotal(lines, 2236, { articles: 2 }).ok, false);
    assert.equal(findTicketsForTotal(lines, 2678, { articles: 2 }).ok, false);
  });
  it("un artículo ya cobrado no se puede volver a cobrar dentro de OTRO grupo", () => {
    const k39 = lines.find((l) => Number(l.ticketId) === 39)!.key!;
    // $1.118 de 1 artículo: está el 39 (vendedor 1) y el 40 (vendedor 2). Cobrado el 39, queda solo el 40.
    const m = findTicketsForTotal(lines, 1118, { articles: 1, usedKeys: [k39] });
    assert.ok(m.ok);
    assert.deepEqual(m.candidates.map((t) => t.ticketId), ["40"]);
    // Y el ticket 38-39 ya no se ofrece como libre.
    const m2 = findTicketsForTotal(lines, 73118, { articles: 2, usedKeys: [k39] });
    assert.equal(m2.ok, false);
  });
});

describe("3 y 4: vínculo por código y unidad de venta; importe de la balanza", () => {
  const plus = new Map<number, ScalePluInfo>([
    [2, { number: 2, code: 2, name: "GRINGO CAJON DE", saleType: "U" }],
    [5, { number: 5, code: 5, name: "TROZADITOx1x2", saleType: "P" }]
  ]);
  const [ticket] = groupTickets(parseSalesReport(t3095.map((l) => l.text).join("^") + "F").lines);

  it("[ticket REAL] CAJON 1 u. $72.000 + TROZADITO 0,215 kg $1.118, con el importe de la balanza", () => {
    const r = linkTicketLines(ticket, plus, GRINGOS);
    assert.ok(r.ok);
    assert.deepEqual(r.lines.map((l) => [l.product.code, l.quantity, l.amount]), [["2", 1, 72000], ["5", 0.215, 1118]]);
  });
  it("el precio de Patagonia NO interviene (distinto o en 0): mismo resultado", () => {
    const r = linkTicketLines(ticket, plus, GRINGOS.map((p) => ({ ...p, priceRetail: p.code === "5" ? 0 : 99999 })));
    assert.ok(r.ok);
    assert.deepEqual(r.lines.map((l) => l.amount), [72000, 1118]);
  });
  it("se vincula por el CÓDIGO que tiene el PLU en la balanza, no por su número", () => {
    const moved = new Map(plus);
    moved.set(5, { number: 5, code: 17, name: "ALITAS", saleType: "P" });
    const r = linkTicketLines(ticket, moved, GRINGOS);
    assert.ok(r.ok);
    assert.equal(r.lines[1].product.name, "ALITAS");
  });
  it("código sin producto en Patagonia: no carga nada", () => {
    const r = linkTicketLines(ticket, plus, GRINGOS.filter((p) => p.code !== "2"));
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /código 2/);
  });
  it("unidad de venta distinta (balanza por peso, Patagonia por unidad): no carga nada", () => {
    const r = linkTicketLines(ticket, plus, GRINGOS.map((p) => (p.code === "5" ? { ...p, unit: "unit" as const } : p)));
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /por peso.*por unidad/);
  });
  it("el reporte trae gramos para un producto unitario: no carga nada", () => {
    const wrong = new Map(plus);
    wrong.set(2, { number: 2, code: 2, name: "GRINGO CAJON DE", saleType: "P" });
    assert.equal(linkTicketLines(ticket, wrong, GRINGOS).ok, false);
  });
  it("producto que no se pudo leer de la balanza: no carga nada", () => {
    assert.equal(linkTicketLines(ticket, new Map([[2, plus.get(2)!]]), GRINGOS).ok, false);
  });
});

describe("[SIMULADO] todo el camino contra una Cuora simulada según el documento", () => {
  it("un ticket: lo carga; solo manda lecturas (23, 39, 72, 62)", async () => {
    const fake = scale();
    const r = await read(fake);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.candidates.length, 1);
    assert.deepEqual(r.candidates[0].lines!.map((l) => [l.product.code, l.quantity, l.amount]), [["2", 1, 72000], ["5", 0.215, 1118]]);
    assert.deepEqual([...new Set(fake.received.map((x) => x.fn))].sort((a, b) => a - b), [39, 62, 72]);
  });
  it("dos tickets iguales: devuelve los dos, cada uno con su detalle, para que elija la persona", async () => {
    const r = await read(scale([...t3095, ...t3101]));
    assert.ok(r.ok);
    assert.deepEqual(r.candidates.map((c) => [Number(c.ticket.ticketId), c.ticket.firstTime]), [[3101, "13:20:10"], [3095, "12:55:34"]]);
  });
  it("ya cobrado en la base (por identidad): queda el otro", async () => {
    const r = await read(scale([...t3095, ...t3101]), { charged: async (keys) => new Set(keys.filter((k) => k.includes(":3101:"))) });
    assert.ok(r.ok);
    assert.deepEqual(r.candidates.map((c) => Number(c.ticket.ticketId)), [3095]);
    // Y avisa que hay uno igual ya cobrado: el papel podría ser ese (reescaneo), así que se confirma.
    assert.deepEqual(r.charged.map((t) => Number(t.ticketId)), [3101]);
  });
  it("producto sin precio en Patagonia vendido en la balanza: se carga con el importe de la balanza", async () => {
    const r = await readTicketDetail(new SystelClient(scale([fakeSaleLine({ ticket: 3200, date: "13/10/26", time: "13:00:00", plu: 17, grams: 1250, amount: 5625 })], REAL_CONFIG_AA), { address: 20, busyRetryMs: [] }), {
      code: "2201000056259",
      amount: 5625,
      products: GRINGOS,
      usedKeys: [],
      now: DAY
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.candidates[0].lines!.map((l) => [l.product.name, l.quantity, l.amount]), [["ALITAS", 1.25, 5625]]);
  });
  it("código con N.º de balanza de OTRA balanza (formato 22BB…): no carga nada", async () => {
    const r = await readTicketDetail(new SystelClient(scale(t3095, REAL_CONFIG_BB), { address: 20, busyRetryMs: [] }), { code: "2221000731185", amount: 73118, products: GRINGOS, usedKeys: [], now: DAY });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /balanza N\.º 21/);
  });
  it("E3 al principio: reintenta; E3 que no se va: no carga nada", async () => {
    const f1 = scale();
    f1.busyReplies = 2;
    assert.ok((await read(f1)).ok);
    const f2 = scale();
    f2.busyReplies = 1000;
    const r = await read(f2);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /E3/);
  });
});

describe("[REAL 14/10] reporte vacío (\"F\") = sin ventas guardadas, NO error de comunicación", () => {
  it("la balanza contesta solo \"F\" → \"sin_ventas\" (no se reintenta ni se pide volver a escanear)", async () => {
    const fake = scale([]);
    const r = await read(fake);
    assert.equal(r.ok, false);
    assert.equal((r as { stage: string }).stage, "sin_ventas");
    assert.equal(fake.received.filter((x) => x.fn === 72).length, 1);
  });
  it("la balanza no contesta, o contesta E3 siempre → \"lectura\" (problema de comunicación)", async () => {
    const mute = scale();
    mute.silent = true;
    assert.equal(((await read(mute)) as { stage: string }).stage, "lectura");
    const busy = scale();
    busy.busyReplies = 1000;
    assert.equal(((await read(busy)) as { stage: string }).stage, "lectura");
  });
});
