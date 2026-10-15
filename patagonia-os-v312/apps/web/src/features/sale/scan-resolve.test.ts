import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { DEFAULT_SCALE_CONFIG } from "./scale-barcode";
import { CARNES_PATAGONIA_CONFIG, CARNES_PATAGONIA_LABELS, LOS_GRINGOS_LABEL_CONFIG, LOS_GRINGOS_TOTAL_TICKET, LOS_GRINGOS_TWO_ITEM_TICKET, SYSTEL_LABEL_CONFIG, TRIPLES_LABELS, TRIPLES_TOTAL_WITHOUT_AMOUNT } from "./scale-real-labels";
import { resolveScan, validEan13 } from "./scan-resolve";

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
  it("2220000007801 = $780: el TOTAL no se carga (no dice qué productos son); pide escanear cada producto", () => {
    const r = resolveScan(LOS_GRINGOS_TOTAL_TICKET[0], [product("5", "TROZADITOx1x2", "kg", 5200)], LOS_GRINGOS_LABEL_CONFIG);
    assert.equal(r.type, "systel_total");
    assert.match((r as { message: string }).message, /TOTAL del ticket \(\$780\).*CADA producto/);
  });

  it("[REAL] 2202000731184 = $73.118 de 2 artículos: NUNCA se convierte en kilos de un producto", () => {
    const t = LOS_GRINGOS_TWO_ITEM_TICKET;
    const gringos = t.items.map((i) => product(i.plu, i.name, i.unit, i.unitPrice));
    assert.ok(validEan13(t.totalCode));
    const r = resolveScan(t.totalCode, gringos, LOS_GRINGOS_LABEL_CONFIG);
    // Nunca kilos calculados: o se lee el detalle de la balanza (systel_total), o no se carga nada.
    assert.equal(r.type, "systel_total");
    assert.equal((r as { amount: number }).amount, 73118);
    assert.match((r as { message: string }).message, /\$73\.118/);
    // El código impreso debajo de cada artículo (todo ceros) no es de ningún producto.
    assert.equal(resolveScan(t.blankItemCode, gringos, LOS_GRINGOS_LABEL_CONFIG).type, "search");
  });

  it("[REAL ticket, códigos ARMADOS con el formato de la balanza] con 'USAR EAN GRAL.' cada artículo da producto y cantidad exactos", () => {
    const t = LOS_GRINGOS_TWO_ITEM_TICKET;
    const gringos = t.items.map((i) => product(i.plu, i.name, i.unit, i.unitPrice));
    // E_U=21PPPPCCCCCC y E_P=20PPPPCCCCCC (leídos de esta balanza el 09/10).
    const cajon = resolveScan(withCheck("210002000001"), gringos, LOS_GRINGOS_LABEL_CONFIG);
    const troz = resolveScan(withCheck("200005000215"), gringos, LOS_GRINGOS_LABEL_CONFIG);
    assert.equal(cajon.type, "label");
    assert.equal(troz.type, "label");
    const c = cajon as { product: Product; quantity: number };
    const z = troz as { product: Product; quantity: number };
    assert.deepEqual([c.product.code, c.quantity, Math.round(c.quantity * c.product.priceRetail)], ["2", 1, 72000]);
    assert.deepEqual([z.product.code, z.quantity, Math.round(z.quantity * z.product.priceRetail)], ["5", 0.215, 1118]);
    assert.equal(Math.round(c.quantity * 72000) + Math.round(z.quantity * 5200), t.total);
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
  it("por unidad (21…): si la cantidad viene entera, 2 unidades = 000002 → 2", () => {
    const r = resolveScan(withCheck("210010000002"), [product("10", "HUEVOS MAPLE", "unit", 4000)], LOS_GRINGOS_LABEL_CONFIG);
    assert.equal(r.type, "label");
    assert.equal((r as { quantity: number }).quantity, 2);
  });
  it("por unidad: si no da un número entero de unidades, error y no se agrega (no vende 2,5 unidades)", () => {
    const r = resolveScan(withCheck("210010002500"), [product("10", "HUEVOS MAPLE", "unit", 4000)], LOS_GRINGOS_LABEL_CONFIG);
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

describe("[REAL] Kretz Aura en Pre-Empaque (Pollo y mar 15/10/2026, un ticket por producto)", () => {
  // Ticket real "ENV:15OCT26 COSTELETAS 0.245kg @ 15900$/kg 3895$", código 2002103895000 (2-3-7 con importe).
  const AURA_ITEM = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" as const };
  const products = [product("21", "COSTELETAS", "kg", 15900), product("1", "milanesas de pollo", "kg", 11600)];

  it("carga el producto con sus kilos y el importe EXACTO del papel ($3.895, no $3.896)", () => {
    const r = resolveScan("2002103895000", products, AURA_ITEM);
    assert.equal(r.type, "label");
    assert.equal(r.type === "label" && r.product.code, "21");
    assert.equal(r.type === "label" && r.quantity, 0.245);
    assert.equal(r.type === "label" && r.amount, 3895);
  });

  it("el ticket con varios productos (código del TOTAL 998) sigue siendo un total", () => {
    const r = resolveScan("2099806737003", products, AURA_ITEM);
    assert.equal(r.type, "ticket_total");
    assert.equal(r.type === "ticket_total" && r.amount, 6737);
  });
});
