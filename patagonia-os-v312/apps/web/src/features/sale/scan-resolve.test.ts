import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { DEFAULT_SCALE_CONFIG } from "./scale-barcode";
import { CARNES_PATAGONIA_CONFIG, CARNES_PATAGONIA_LABELS, LOS_GRINGOS_LABEL_CONFIG, LOS_GRINGOS_TOTAL_TICKET, SYSTEL_LABEL_CONFIG, TRIPLES_LABELS, TRIPLES_TOTAL_WITHOUT_AMOUNT } from "./scale-real-labels";
import { productsMatchingTotal, quantityForTotal, resolveScan, validEan13 } from "./scan-resolve";

const product = (code: string, name: string, unit: "kg" | "unit", priceRetail: number, active = true) =>
  ({ id: `id-${code}`, code, name, unit, priceRetail, active }) as unknown as Product;

function withCheck(first12: string): string {
  const d = first12.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
}

describe("[REAL] etiquetas de la balanza de Carnes Patagonia", () => {
  const products = [...new Set(CARNES_PATAGONIA_LABELS.map(([, plu]) => plu))].map((plu) => product(plu, `Producto ${plu}`, "kg", 10000));

  it("las 29 etiquetas reales: producto correcto y los kilos exactos", () => {
    for (const [code, plu, kg] of CARNES_PATAGONIA_LABELS) {
      assert.ok(validEan13(code), `${code} tiene verificador EAN-13 válido`);
      const r = resolveScan(code, products, CARNES_PATAGONIA_CONFIG);
      assert.equal(r.type, "label", code);
      if (r.type !== "label") continue;
      assert.equal(r.product.code, plu, code);
      assert.equal(r.quantity, kg, code);
    }
  });

  it("si ese producto no está en Patagonia: error claro, no se agrega nada", () => {
    const r = resolveScan("2000504011722", products.filter((p) => p.code !== "504"), CARNES_PATAGONIA_CONFIG);
    assert.equal(r.type, "error");
    assert.match((r as { message: string }).message, /N\.º 504/);
  });

  it("si el producto está desactivado: error que lo dice", () => {
    const r = resolveScan("2000504011722", [...products.filter((p) => p.code !== "504"), product("504", "MILANESA POLLO", "kg", 10000, false)], CARNES_PATAGONIA_CONFIG);
    assert.equal(r.type, "error");
    assert.match((r as { message: string }).message, /desactivado/);
  });

  it("si el producto no tiene precio: error (se cobraría $0), no se agrega", () => {
    const r = resolveScan("2000504011722", [product("504", "MILANESA POLLO", "kg", 0)], CARNES_PATAGONIA_CONFIG);
    assert.equal(r.type, "error");
    assert.match((r as { message: string }).message, /no tiene precio/);
  });

  it("un dígito mal leído (verificador incorrecto) no se toma como etiqueta", () => {
    const r = resolveScan("2000504011723", products, CARNES_PATAGONIA_CONFIG);
    assert.notEqual(r.type, "label");
  });
});

describe("[REAL] ticket de total de la Systel de Los gringos", () => {
  it("2220000007801 = $780, sin producto ni stock", () => {
    const r = resolveScan(LOS_GRINGOS_TOTAL_TICKET[0], [product("5", "TROZADITOx1x2", "kg", 5200)], LOS_GRINGOS_LABEL_CONFIG);
    assert.deepEqual(r, { type: "ticket_total", amount: LOS_GRINGOS_TOTAL_TICKET[1], key: "ticket-2220000007801" });
  });
});

describe("[SINTÉTICO] etiqueta por producto de la Systel (formato configurado en la balanza, sin etiqueta real todavía)", () => {
  const trozadito = product("5", "TROZADITOx1x2", "kg", 5200);
  it("20 0005 000150: TROZADITO 0,150 kg (el producto y el peso del ticket real de la foto)", () => {
    const r = resolveScan(withCheck("200005000150"), [trozadito], LOS_GRINGOS_LABEL_CONFIG);
    assert.equal(r.type, "label");
    assert.equal((r as { quantity: number }).quantity, 0.15);
  });
  it("por unidad (21…): si la cantidad viene en milésimas, 2 unidades = 000002000 → 2", () => {
    const r = resolveScan(withCheck("210010002000"), [product("10", "HUEVOS MAPLE", "unit", 4000)], LOS_GRINGOS_LABEL_CONFIG);
    assert.equal(r.type, "label");
    assert.equal((r as { quantity: number }).quantity, 2);
  });
  it("por unidad: si no da un número entero de unidades, error y no se agrega (no vende 0,002 unidades)", () => {
    const r = resolveScan(withCheck("210010000002"), [product("10", "HUEVOS MAPLE", "unit", 4000)], LOS_GRINGOS_LABEL_CONFIG);
    assert.equal(r.type, "error");
    assert.match((r as { message: string }).message, /por unidad/);
  });
});

describe("prioridades y códigos que no son de balanza", () => {
  it("un código idéntico al de un producto gana (aunque parezca etiqueta)", () => {
    const p = product("2000504011722", "Producto con ese EAN", "unit", 100);
    assert.deepEqual(resolveScan("2000504011722", [p], CARNES_PATAGONIA_CONFIG), { type: "product", product: p });
  });
  it("un EAN común de fábrica (779…) no se lee como etiqueta de balanza", () => {
    const ean = withCheck("779123400504");
    assert.equal(resolveScan(ean, [product("504", "X", "kg", 1000)], CARNES_PATAGONIA_CONFIG).type, "search");
  });
  it("con el formato de fábrica Kretz (1-5-5) sigue andando", () => {
    const r = resolveScan(withCheck("200012012500"), [product("12", "Nalga", "kg", 10000)], DEFAULT_SCALE_CONFIG);
    assert.equal(r.type, "label");
    assert.equal((r as { quantity: number }).quantity, 1.25);
  });
  it("código cualquiera que no existe: búsqueda (el hook dice 'No se encontró…')", () => {
    assert.equal(resolveScan("ABC123", [product("1", "X", "kg", 1)], DEFAULT_SCALE_CONFIG).type, "search");
  });
});

describe("[REAL] ticket de la balanza Systel de TripleS (un código por producto)", () => {
  const products = TRIPLES_LABELS.map(([, code, , name]) => product(code, name, "kg", 10000));

  it("las 4 etiquetas reales, con el formato Systel: producto correcto y kilos exactos", () => {
    for (const [code, plu, kg] of TRIPLES_LABELS) {
      assert.ok(validEan13(code), code);
      const r = resolveScan(code, products, SYSTEL_LABEL_CONFIG);
      assert.equal(r.type, "label", code);
      assert.equal((r as { product: Product }).product.code, plu, code);
      assert.equal((r as { quantity: number }).quantity, kg, code);
    }
  });

  it("con el formato de fábrica Kretz (sin configurar) leería 10 veces menos: por eso hay que configurar la sucursal", () => {
    const r = resolveScan("2001230001759", products, DEFAULT_SCALE_CONFIG);
    assert.equal((r as { quantity: number }).quantity, 0.017);
  });

  it("el código del TOTAL (22 11 99999999) NO se lee como $99.999.999: avisa que escanee cada producto", () => {
    const r = resolveScan(TRIPLES_TOTAL_WITHOUT_AMOUNT, products, SYSTEL_LABEL_CONFIG);
    assert.equal(r.type, "ticket_without_amount");
    assert.match((r as { message: string }).message, /cada producto/);
  });
});

describe("[REAL] ticket de TOTAL de Los gringos con UN producto: se elige el producto y se descuentan los kilos", () => {
  // Los 4 productos con precio que tiene Los gringos en Patagonia (13/10).
  const gringos = [product("10", "PECHUGAC/H x1x5", "kg", 6480), product("5", "TROZADITOx1x2", "kg", 5200), product("2", "GRINGO CAJON DE POLLO", "unit", 72000), product("13", "PECHUGA S/H x1x3", "kg", 9000)];

  it("2220000012225 = $1.222 (ticket: TROZADITO 0.235 kg x 5200 = 1222) → TROZADITO 0,235 kg, el único que da justo", () => {
    const r = resolveScan("2220000012225", gringos, SYSTEL_LABEL_CONFIG);
    assert.equal(r.type, "ticket_total");
    const c = productsMatchingTotal(1222, gringos);
    assert.deepEqual(c.map((x) => [x.product.code, x.quantity]), [["5", 0.235]]);
    assert.deepEqual(quantityForTotal(1222, gringos[1]), { ok: true, quantity: 0.235, exact: true });
  });

  it("2220000007801 = $780 (ticket: TROZADITO 0.150 kg) → TROZADITO 0,150 kg", () => {
    assert.deepEqual(productsMatchingTotal(780, gringos).map((x) => [x.product.code, x.quantity]), [["5", 0.15]]);
  });

  it("producto sin precio o por unidad que no da entero: error claro", () => {
    assert.equal(quantityForTotal(1222, product("7", "SIN PRECIO", "kg", 0)).ok, false);
    assert.equal(quantityForTotal(1222, gringos[2]).ok, false);
    assert.deepEqual(quantityForTotal(144000, gringos[2]), { ok: true, quantity: 2, exact: true });
  });

  it("si el precio de Patagonia no es el de la balanza, se carga igual pero avisa que no da justo", () => {
    const r = quantityForTotal(1222, product("5", "TROZADITO", "kg", 5300));
    assert.deepEqual(r, { ok: true, quantity: 0.231, exact: false });
  });
});
