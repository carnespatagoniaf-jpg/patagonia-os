import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Product } from "@patagonia/domain";
import { SystelClient } from "./systel-client";
import { FakeCuora } from "./systel-fake";
import { PLUS_BALANZA, PRODUCTOS_PATAGONIA } from "./systel-real-los-gringos";
import { REAL_REPORT_1310 } from "./systel-real-report-1310";
import { assignLineKeys, findTicketsForTotal, groupTickets, linkTicketLines, parseSalesReport, sameProductName, type ScalePluInfo } from "./systel-sales";
import { readTicketDetail } from "./systel-ticket-detail";
import { fakeReadRecord } from "./systel-fake";

const plus = new Map<number, ScalePluInfo>(PLUS_BALANZA.split(";").map((r) => {
  const [c, t, n] = r.split("|");
  return [Number(c), { number: Number(c), code: Number(c), name: n, saleType: t as "P" | "U" }];
}));
const products = PRODUCTOS_PATAGONIA.split(";").map((r) => {
  const [code, unit, name, price] = r.split("|");
  return { id: `p${code}`, code, unit, name, priceRetail: Number(price), cost: 0, stock: 0, minStock: 0, active: true } as unknown as Product;
});

describe("[REAL] reporte de ventas de la balanza de Los gringos (13/10) con su catálogo real", () => {
  const parsed = parseSalesReport(REAL_REPORT_1310);
  const lines = assignLineKeys(parsed.lines, 20);

  it("se leen los 95 artículos (N.º de PLU de 4 cifras y \";\" entre artículos, distinto del documento)", () => {
    assert.equal(parsed.ok, true, parsed.problem ?? "");
    assert.equal(parsed.lines.length, 95);
  });

  it("numera POR TICKET (hay tickets con varios artículos)", () => {
    assert.ok(groupTickets(lines).some((t) => t.lines.length > 1));
  });

  it("el TOTAL real 2202000731184 ($73.118, 2 artículos) da UN solo ticket: el 3095 de la foto, con sus kilos e importes", () => {
    const m = findTicketsForTotal(lines, 73118, { articles: 2 });
    assert.ok(m.ok);
    assert.deepEqual(m.candidates.map((c) => c.ticketId), ["3095"]);
    const r = linkTicketLines(m.candidates[0], plus, products);
    assert.ok(r.ok, (r as { reason?: string }).reason);
    assert.deepEqual(r.lines.map((l) => [l.product.name, l.quantity, l.amount]), [["TROZADITOx1x2", 0.215, 1118], ["GRINGO CAJON DE POLLO", 1, 72000]]);
  });

  it("los códigos 96 a 103 son otros productos en Patagonia: no se vinculan (no se descuenta stock del producto equivocado)", () => {
    for (const code of [96, 97, 98, 99, 100, 101, 102, 103]) {
      const p = products.find((x) => x.code === String(code))!;
      assert.equal(sameProductName(plus.get(code)!.name, p.name), false, `${code}`);
    }
    for (const code of [1, 2, 5, 13, 34, 48, 68, 90]) {
      const p = products.find((x) => x.code === String(code))!;
      assert.equal(sameProductName(plus.get(code)!.name, p.name), true, `${code} ${plus.get(code)!.name} / ${p.name}`);
    }
  });

  it("[SIMULADO: balanza falsa que contesta con los bytes REALES] Mostrador lee el ticket 3095 desde el TOTAL escaneado", async () => {
    const f = new FakeCuora("max60", { address: 20 });
    f.config = "E_P=20PPPPCCCCII;E_U=21PPPPCCCCII;E_S=22AAIIIIIIII;ETi=S";
    f.plus.set(2, fakeReadRecord("max60", { number: 2, name: "GRINGO CAJON DE", price: 72000, code: 2, type: "U" }));
    f.plus.set(5, fakeReadRecord("max60", { number: 5, name: "TROZADITOx1x2", price: 5200, code: 5, type: "P" }));
    const orig = f.exchange.bind(f);
    f.exchange = async (frame: Uint8Array) => {
      if (frame[1] !== 72) return orig(frame);
      const body = [20, 72, ...Array.from(REAL_REPORT_1310, (c) => c.charCodeAt(0))];
      return Uint8Array.from([...body, body.reduce((a, b) => a ^ b, 0)]);
    };
    const r = await readTicketDetail(new SystelClient(f, { address: 20, busyRetryMs: [] }), { code: "2202000731184", amount: 73118, products, usedKeys: [], now: new Date(2026, 9, 13, 13, 0) });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.candidates.length, 1);
    assert.equal(r.charged.length, 0);
    assert.deepEqual(r.candidates[0].lines!.map((l) => [l.product.code, l.quantity, l.amount]), [["5", 0.215, 1118], ["2", 1, 72000]]);
  });
});
