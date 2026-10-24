import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateRawSync } from "node:zlib";
import { monotributoStatus, purchaseParts, vatPosition, type PurchaseVoucher, type SaleVoucher } from "./accounting-view";
import { buildPurchaseFiles, buildSalesFiles, lidAmount, lidText } from "./libro-iva-digital";
import { amountCell, dateCell, otherTaxesAsIibb, parseMisComprobantes, voucherTypeCell } from "./mis-comprobantes";
import { buildZip, crc32, latin1Bytes } from "./zip";

const sale = (over: Partial<SaleVoucher> = {}): SaleVoucher => ({
  id: "s1", kind: "factura", date: "2026-10-05", voucherType: 6, pointOfSale: 1, number: 4, letter: "B",
  docType: 99, doc: "0", name: null, total: 49286, net: 43425.55, vat: 5860.45, vatRate: 10.5,
  vatLines: [{ rate: 21, net: 12388.24, vat: 2601.53 }, { rate: 10.5, net: 31037.31, vat: 3258.92 }],
  ...over
});

const purchase = (over: Partial<PurchaseVoucher> = {}): PurchaseVoucher => ({
  id: "p1", purchaseId: null, supplierId: null, period: "2026-10-01", voucherDate: "2026-10-03", voucherType: 1,
  pointOfSale: 3, number: 1234, sellerDocType: 80, sellerDoc: "20123456786", sellerName: "Frigorífico Del Sur",
  vatLines: [{ rate: 21, net: 1000, vat: 210 }, { rate: 10.5, net: 2000, vat: 210 }],
  netTaxed: 3000, vatTotal: 420, noTaxed: 0, exempt: 0, percVat: 90, percIibb: 30, percNational: 0, percMunicipal: 0,
  internalTaxes: 0, otherTaxes: 0, total: 3540, cae: null, source: "manual", notes: null,
  ...over
});

describe("Libro IVA Digital", () => {
  it("ventas: registro de 266 y alícuotas de 62, en el mismo orden", () => {
    const files = buildSalesFiles([sale(), sale({ id: "s2", number: 5, voucherType: 8, kind: "nota_credito", total: 100, vatLines: [{ rate: 21, net: 82.64, vat: 17.36 }] })]);
    const lines = files.vouchers.split("\r\n").filter(Boolean);
    const rates = files.rates.split("\r\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.length === 266));
    assert.ok(rates.every((l) => l.length === 62));
    assert.equal(rates.length, 3);
    const l = lines[0];
    assert.equal(l.slice(0, 8), "20261005");
    assert.equal(l.slice(8, 11), "006");
    assert.equal(l.slice(11, 16), "00001");
    assert.equal(l.slice(16, 36), "00000000000000000004");
    assert.equal(l.slice(56, 58), "99");
    assert.equal(l.slice(78, 108).trim(), "CONSUMIDOR FINAL");
    assert.equal(l.slice(108, 123), "000000004928600");
    assert.equal(l.slice(228, 231), "PES");
    assert.equal(l.slice(231, 241), "0001000000");
    assert.equal(l.slice(241, 242), "2");
    assert.equal(rates[0], "006" + "00001" + "00000000000000000004" + "000000001238824" + "0005" + "000000000260153");
    assert.equal(rates[1].slice(43, 47), "0004");
    assert.equal(rates[2].slice(0, 3), "008");
  });

  it("compras: A con dos alícuotas y percepciones; C sin alícuotas", () => {
    const files = buildPurchaseFiles([purchase(), purchase({ id: "p2", voucherType: 11, number: 77, vatLines: [], total: 15000, percVat: 0, percIibb: 0, sellerName: "Verdulería Juan" })]);
    const lines = files.vouchers.split("\r\n").filter(Boolean);
    const rates = files.rates.split("\r\n").filter(Boolean);
    assert.ok(lines.every((l) => l.length === 325));
    assert.ok(rates.every((l) => l.length === 84));
    assert.equal(rates.length, 2, "solo la A lleva alícuotas");
    const a = lines[0];
    assert.equal(a.slice(52, 54), "80");
    assert.equal(a.slice(54, 74), "00000000020123456786");
    assert.equal(a.slice(74, 104).trim(), "FRIGORIFICO DEL SUR");
    assert.equal(a.slice(104, 119), "000000000354000");
    assert.equal(a.slice(149, 164), "000000000009000", "percepción de IVA");
    assert.equal(a.slice(179, 194), "000000000003000", "percepción de IIBB");
    assert.equal(a.slice(237, 238), "2");
    assert.equal(a.slice(239, 254), "000000000042000", "crédito fiscal computable");
    const c = lines[1];
    assert.equal(c.slice(237, 238), "0");
    assert.equal(c.slice(239, 254), "000000000000000");
    assert.equal(rates[0].slice(28, 30), "80");
    assert.equal(rates[0].slice(65, 69), "0005");
  });

  it("A toda exenta: una línea al 0% con código E", () => {
    const files = buildPurchaseFiles([purchase({ vatLines: [], exempt: 3540, percVat: 0, percIibb: 0 })]);
    assert.equal(files.vouchers.slice(237, 239), "1E");
    assert.equal(files.rates.slice(65, 69), "0003");
  });

  it("importes y texto", () => {
    assert.equal(lidAmount(1234.5), "000000000123450");
    assert.equal(lidAmount(-10), "-00000000001000");
    assert.equal(lidText("Carnicería Ñandú", 10), "CARNICERIA");
  });
});

describe("posición de IVA y monotributo", () => {
  it("débito − crédito − percepciones; la nota de crédito resta", () => {
    const pos = vatPosition(
      [sale(), sale({ id: "c", voucherType: 8, vatLines: [{ rate: 21, net: 100, vat: 21 }] }), sale({ id: "x", letter: "C", voucherType: 11 })],
      [purchase(), purchase({ id: "b", voucherType: 6, vatLines: [], percVat: 10 })]
    );
    assert.equal(pos.debit, 5860.45 - 21);
    assert.equal(pos.credit, 420);
    assert.equal(pos.perceptions, 100);
    assert.equal(pos.balance, Math.round((5860.45 - 21 - 420 - 100) * 100) / 100);
    assert.deepEqual(pos.salesByRate.map((r) => r.rate), [10.5, 21]);
  });

  it("categoría por lo facturado", () => {
    const cats = [{ category: "A", maxIncome: 12009410.45 }, { category: "B", maxIncome: 17595182.74 }, { category: "K", maxIncome: 126610838.75 }];
    assert.equal(monotributoStatus(5000000, cats).category, "A");
    const b = monotributoStatus(17000000, cats);
    assert.equal(b.category, "B");
    assert.equal(b.level, "cerca");
    assert.equal(monotributoStatus(200000000, cats).level, "excede");
  });

  it("suma de las partes de una compra", () => {
    assert.equal(purchaseParts(purchase()), 3540);
  });
});

describe("Mis Comprobantes", () => {
  it("lee el archivo nuevo (por alícuota) con título arriba", () => {
    const table = [
      ["Mis Comprobantes Recibidos - CUIT 27182448902"],
      [],
      ["Fecha de Emisión", "Tipo de Comprobante", "Punto de Venta", "Número Desde", "Número Hasta", "Cód. Autorización", "Tipo Doc. Emisor", "Nro. Doc. Emisor", "Denominación Emisor", "Tipo Cambio", "Moneda",
       "Imp. Neto Gravado IVA 10,5%", "IVA 10,5%", "Imp. Neto Gravado IVA 21%", "IVA 21%", "Imp. Neto No Gravado", "Imp. Op. Exentas", "Otros Tributos", "Total IVA", "Imp. Total"],
      ["03/10/2026", "1 - Factura A", "3", "1234", "1234", "86431020107652", "CUIT", "20123456786", "Frigorífico Del Sur", "1", "$",
       "2000,00", "210,00", "1000,00", "210,00", "0", "0", "120,00", "420,00", "3540,00"],
      ["05/10/2026", "11 - Factura C", "1", "77", "77", "1", "CUIT", "20123456786", "Verdulería Juan", "1", "$", "", "", "", "", "", "", "", "", "15000"]
    ];
    const r = parseMisComprobantes(table as never);
    assert.ok(r.headerFound);
    assert.ok(r.perRate);
    assert.equal(r.rows.length, 2);
    const a = r.rows[0].voucher!;
    assert.equal(a.voucher_date, "2026-10-03");
    assert.equal(a.voucher_type, 1);
    assert.deepEqual(a.vat_lines, [{ rate: 10.5, net: 2000, vat: 210 }, { rate: 21, net: 1000, vat: 210 }]);
    assert.equal(a.other_taxes, 120);
    assert.equal(a.total, 3540);
    // Con la opción tildada, los "Otros tributos" pasan a percepción de IIBB (el total no cambia).
    const [moved] = otherTaxesAsIibb([a]);
    assert.equal(moved.perc_iibb, 120);
    assert.equal(moved.other_taxes, 0);
    assert.equal(moved.total, 3540);
    assert.equal(r.rows[1].voucher!.vat_lines.length, 0);
  });

  it("archivo viejo: adivina la alícuota por IVA/neto", () => {
    const table = [
      ["Fecha", "Tipo", "Punto de Venta", "Número Desde", "Nro. Doc. Emisor", "Denominación Emisor", "Imp. Neto Gravado", "IVA", "Imp. Total"],
      ["2026-10-01", "Factura A", "2", "10", "20123456786", "X", "1000", "105", "1105"]
    ];
    const v = parseMisComprobantes(table as never).rows[0].voucher!;
    assert.deepEqual(v.vat_lines, [{ rate: 10.5, net: 1000, vat: 105 }]);
  });

  it("celdas", () => {
    assert.equal(amountCell("1.234,56"), 1234.56);
    assert.equal(amountCell("1234.56"), 1234.56);
    assert.equal(dateCell("3/10/2026"), "2026-10-03");
    assert.equal(voucherTypeCell("011"), 11);
    assert.equal(voucherTypeCell("Nota de Crédito A"), 3);
  });
});

describe("zip", () => {
  it("guarda los archivos tal cual (método store) con su CRC", () => {
    const data = latin1Bytes("hola\r\n");
    const zip = buildZip([{ name: "a.txt", data }]);
    const view = new DataView(zip.buffer);
    assert.equal(view.getUint32(0, true), 0x04034b50);
    assert.equal(view.getUint32(14, true), crc32(data));
    assert.equal(Buffer.from(zip.slice(30 + 5, 30 + 5 + data.length)).toString("latin1"), "hola\r\n");
    assert.equal(crc32(latin1Bytes("123456789")), 0xcbf43926);
    assert.ok(inflateRawSync);
  });
});
