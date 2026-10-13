import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Product } from "@patagonia/domain";
import { SystelClient } from "./systel-client";
import { FakeCuora, fakeSaleLine } from "./systel-fake";
import { findTicketForTotal, groupTickets, parseSalesReport, salesReportRequest, ticketToCart } from "./systel-sales";
import { readTicketDetail } from "./systel-ticket-detail";

const product = (code: string, name: string, unit: "kg" | "unit", priceRetail: number) =>
  ({ id: `id-${code}`, code, name, unit, priceRetail, cost: 0, stock: 0, minStock: 0, active: true }) as unknown as Product;

// Los 4 productos con precio de Los gringos en Patagonia (13/10).
const GRINGOS = [product("10", "PECHUGAC/H x1x5", "kg", 6480), product("5", "TROZADITOx1x2", "kg", 5200), product("2", "GRINGO CAJON DE POLLO", "unit", 72000), product("13", "PECHUGA S/H x1x3", "kg", 9000)];

// [SIMULADO con los datos del ticket REAL] Los gringos 13/10/2026 12:55:34, operación 20-3095:
// (2) GRINGO CAJON DE 1un × 72000 = 72000 · (5) TROZADITOx1x2 0.215kg × 5200 = 1118 · TOTAL $73118.
// Los artículos y los importes son los del ticket; el número de ticket (3095), el vendedor (1) y el
// sector (1) en el reporte son SUPUESTOS: el formato real de la respuesta 72 nunca se leyó.
const REAL_TICKET = [
  fakeSaleLine({ ticket: 3095, date: "13/10/26", time: "12:55:34", plu: 2, units: 1, amount: 72000 }),
  fakeSaleLine({ ticket: 3095, date: "13/10/26", time: "12:55:34", plu: 5, grams: 215, amount: 1118 })
];
const DAY = new Date(2026, 9, 13, 12, 56);

function scale() {
  const fake = new FakeCuora("max60", { address: 20 });
  fake.sales = [
    fakeSaleLine({ ticket: 3094, date: "13/10/26", time: "12:50:02", plu: 5, grams: 235, amount: 1222 }),
    ...REAL_TICKET,
    fakeSaleLine({ ticket: 3080, date: "12/10/26", time: "18:00:00", plu: 2, units: 1, amount: 72000 })
  ];
  return fake;
}

describe("reporte de ventas de la Systel (función 72, solo lectura)", () => {
  it("pedido: día, mes y año de inicio y de fin, 2 números cada uno", () => {
    assert.equal(salesReportRequest(DAY), "131026131026");
  });

  it("interpreta los artículos con los anchos del documento, con o sin \"^\" entre artículos", () => {
    for (const sep of ["^", ""]) {
      const r = parseSalesReport(REAL_TICKET.map((l) => l.text).join(sep) + "F");
      assert.equal(r.ok, true, sep);
      assert.deepEqual(r.lines.map((l) => [l.ticketId, l.plu, l.units, l.grams, l.amount]), [["000003095", 2, 1, 0, 72000], ["000003095", 5, 0, 215, 1118]]);
    }
  });

  it("si no termina en F, o algo no coincide con el formato: no se usa nada", () => {
    assert.equal(parseSalesReport(REAL_TICKET[0].text).ok, false);
    assert.equal(parseSalesReport(REAL_TICKET[0].text.replace("^000002^", "^2^") + "F").ok, false);
    const cut = parseSalesReport(REAL_TICKET[0].text + "^" + REAL_TICKET[1].text.slice(0, 30) + "F");
    assert.equal(cut.ok, false);
    assert.match(cut.problem!, /no coincide/);
  });

  it("[ticket REAL de 2 artículos] $73.118 → CAJON 1 u. ($72.000) + TROZADITO 0,215 kg ($1.118)", () => {
    const tickets = groupTickets(parseSalesReport(REAL_TICKET.map((l) => l.text).join("^") + "F").lines);
    const m = findTicketForTotal(tickets, 73118);
    assert.ok(m.ok);
    const cart = ticketToCart(m.ticket, GRINGOS);
    assert.ok(cart.ok);
    assert.deepEqual(cart.lines.map((l) => [l.product.code, l.product.name, l.quantity, l.amount]), [["2", "GRINGO CAJON DE POLLO", 1, 72000], ["5", "TROZADITOx1x2", 0.215, 1118]]);
  });

  it("el precio de Patagonia distinto al de la balanza: no carga nada y dice cuál", () => {
    const tickets = groupTickets(parseSalesReport(REAL_TICKET.map((l) => l.text).join("^") + "F").lines);
    const m = findTicketForTotal(tickets, 73118);
    assert.ok(m.ok);
    const r = ticketToCart(m.ticket, GRINGOS.map((p) => (p.code === "5" ? { ...p, priceRetail: 5300 } : p)));
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /TROZADITO.*\$1\.118.*\$5\.300/);
  });

  it("artículo que no existe en Patagonia, o kg/unidad cruzados: no carga nada", () => {
    const tickets = groupTickets(parseSalesReport(REAL_TICKET.map((l) => l.text).join("^") + "F").lines);
    const m = findTicketForTotal(tickets, 73118);
    assert.ok(m.ok);
    assert.equal(ticketToCart(m.ticket, GRINGOS.filter((p) => p.code !== "2")).ok, false);
    assert.equal(ticketToCart(m.ticket, GRINGOS.map((p) => (p.code === "2" ? { ...p, unit: "kg" as const } : p))).ok, false);
  });

  it("ticket ya cobrado, ningún ticket con ese importe, y dos iguales (toma el más reciente y avisa)", () => {
    const lines = parseSalesReport([...REAL_TICKET, fakeSaleLine({ ticket: 3099, date: "13/10/26", time: "13:10:00", plu: 2, units: 1, amount: 72000 }), fakeSaleLine({ ticket: 3099, date: "13/10/26", time: "13:10:00", plu: 5, grams: 215, amount: 1118 })].map((l) => l.text).join("^") + "F").lines;
    const tickets = groupTickets(lines);
    const m = findTicketForTotal(tickets, 73118);
    assert.ok(m.ok);
    assert.equal(m.ticket.ticketId, "000003099");
    assert.equal(m.otherCandidates, 1);
    const used = findTicketForTotal(tickets, 73118, { usedKeys: ["systel-ticket-13/10/26-000003099", "systel-ticket-13/10/26-000003095"] });
    assert.equal(used.ok, false);
    assert.equal(findTicketForTotal(tickets, 5000).ok, false);
  });
});

describe("[SIMULADO] del TOTAL escaneado al detalle, contra una Cuora simulada según el documento", () => {
  it("lee el ticket de HOY y carga cada artículo con su cantidad; solo manda 23 (ping) y 72 (lectura)", async () => {
    const fake = scale();
    const client = new SystelClient(fake, { address: 20, busyRetryMs: [] });
    const r = await readTicketDetail(client, { amount: 73118, products: GRINGOS, usedKeys: [], now: DAY });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.lines.map((l) => [l.product.code, l.quantity]), [["2", 1], ["5", 0.215]]);
    assert.equal(r.key, "systel-ticket-13/10/26-000003095");
    assert.deepEqual([...new Set(fake.received.map((x) => x.fn))].sort((a, b) => a - b), [23, 72]);
    assert.deepEqual(fake.received.filter((x) => x.fn === 72).map((x) => x.data), ["131026131026"]);
  });

  it("la balanza contesta E3 (ocupada) dos veces: reintenta y lo lee", async () => {
    const fake = scale();
    fake.busyReplies = 3; // las 2 órdenes del arranque + la primera 72
    const client = new SystelClient(fake, { address: 20, busyRetryMs: [1, 1, 1] });
    const r = await readTicketDetail(client, { amount: 73118, products: GRINGOS, usedKeys: [], now: DAY });
    assert.ok(r.ok, JSON.stringify(r));
  });

  it("la balanza sigue con E3: no carga nada y dice que no pudo leer", async () => {
    const fake = scale();
    fake.busyReplies = 1000;
    const client = new SystelClient(fake, { address: 20, busyRetryMs: [1, 1] });
    const r = await readTicketDetail(client, { amount: 73118, products: GRINGOS, usedKeys: [], now: DAY });
    assert.equal(r.ok, false);
    assert.equal((r as { stage: string }).stage, "lectura");
    assert.match((r as { reason: string }).reason, /E3/);
  });

  it("sin \"^\" entre artículos (la otra lectura posible del documento) también funciona", async () => {
    const fake = scale();
    fake.salesSeparator = "";
    const r = await readTicketDetail(new SystelClient(fake, { address: 20, busyRetryMs: [] }), { amount: 73118, products: GRINGOS, usedKeys: [], now: DAY });
    assert.ok(r.ok, JSON.stringify(r));
  });

  it("$1.222 del mismo día (1 artículo real: TROZADITO 0,235 kg)", async () => {
    const r = await readTicketDetail(new SystelClient(scale(), { address: 20, busyRetryMs: [] }), { amount: 1222, products: GRINGOS, usedKeys: [], now: DAY });
    assert.ok(r.ok);
    assert.deepEqual(r.lines.map((l) => [l.product.code, l.quantity]), [["5", 0.235]]);
  });
});
