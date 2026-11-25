import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { DEFAULT_SCALE_CONFIG } from "./scale-barcode";
import { CARNES_PATAGONIA_CONFIG, CARNES_PATAGONIA_LABELS, LOS_GRINGOS_LABEL_CONFIG, LOS_GRINGOS_TOTAL_TICKET, LOS_GRINGOS_TWO_ITEM_TICKET, SYSTEL_LABEL_CONFIG, TRIPLES_LABELS, TRIPLES_TOTAL_WITHOUT_AMOUNT } from "./scale-real-labels";
import { labelWeightProblem, resolveScan, validEan13 } from "./scan-resolve";

const product = (code: string, name: string, unit: "kg" | "unit", priceRetail: number, active = true) =>
  ({ id: `id-${code}`, code, name, unit, priceRetail, active }) as unknown as Product;

function withCheck(first12: string): string {
  const d = first12.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
}

describe("[REAL] etiquetas de M2 (Kretz Report LT, 2-3-7 con importe en centavos)", () => {
  const M2 = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" as const };
  const products = [product("2", "Matambre novillo gorina", "kg", 13700), product("99", "Bondiola PifPaf", "kg", 7000), product("6", "Vacio novillo gorina", "kg", 15500)];

  it("las etiquetas reales escaneadas en su Mostrador el 24/10: producto, importe y kilos", () => {
    for (const [code, plu, amount, kg] of [["2009901890008", "99", 1890, 0.27], ["2000258567506", "2", 58567.5, 4.275]] as const) {
      const r = resolveScan(code, products, M2);
      assert.equal(r.type, "label", code);
      if (r.type !== "label") continue;
      assert.equal(r.product.code, plu);
      assert.equal(r.amount, amount);
      assert.equal(r.quantity, kg);
    }
  });

  it("importe que no entró (todo en 0 o todo en 9): error, no se cobra nada", () => {
    for (const first12 of ["200060000000", "200069999999"]) {
      const r = resolveScan(withCheck(first12), products, M2);
      assert.equal(r.type, "error", first12);
      if (r.type === "error") assert.match(r.message, /Vacio novillo gorina.*no trae el importe/);
    }
  });
});

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

describe("Peso de la etiqueta fuera del piloto Systel (auditoría 29/10: El Dorado leyó $99.934 como 99,934 kg)", () => {
  it("más de 31 kg de un producto por kilo se pregunta, no se agrega solo", () => {
    assert.equal(labelWeightProblem("kg", 99.934), "excesivo");
    assert.equal(labelWeightProblem("kg", 31.001), "excesivo");
  });
  it("un peso normal pasa, y las unidades no tienen tope", () => {
    assert.equal(labelWeightProblem("kg", 0.215), null);
    assert.equal(labelWeightProblem("kg", 31), null);
    assert.equal(labelWeightProblem("unit", 40), null);
  });
  it("cero, negativo o no numérico no se agrega", () => {
    assert.equal(labelWeightProblem("kg", 0), "invalido");
    assert.equal(labelWeightProblem("kg", -1), "invalido");
    assert.equal(labelWeightProblem("kg", Number.NaN), "invalido");
  });
  it("la etiqueta real de El Dorado con el formato de fábrica cae como excesiva", () => {
    const nalga = product("1", "NALGA", "kg", 14000);
    const r = resolveScan("2000019993407", [nalga], DEFAULT_SCALE_CONFIG);
    assert.equal(r.type, "label");
    if (r.type === "label") assert.equal(labelWeightProblem(r.product.unit, r.quantity), "excesivo");
  });
});

describe("[REAL] Oliem 18/11: dos balanzas, una con \"21\" + peso y otra con \"20\" + importe", () => {
  // La sucursal quedó leyendo 2-5-5 con peso (Report por red). La otra balanza imprime "20" + PLU 5 + importe en pesos.
  const PLU5_WEIGHT = { prefixLength: 2, pluLength: 5, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" as const };
  const products = [product("0000003", "SALAME CAÑOLI", "kg", 40000), product("212", "PROMO PATA", "kg", 3333)];

  it("21 = peso: SALAME CAÑOLI 0,235 kg", () => {
    const r = resolveScan("2100003002358", products, PLU5_WEIGHT);
    assert.equal(r.type, "label");
    if (r.type === "label") {
      assert.equal(r.product.code, "0000003");
      assert.equal(r.quantity, 0.235);
      assert.equal(r.amount, undefined);
    }
  });

  it("20 = importe: PROMO PATA $5.183 (1,555 kg), no 5,183 kg", () => {
    assert.ok(validEan13("2000212051836"));
    const r = resolveScan("2000212051836", products, PLU5_WEIGHT);
    assert.equal(r.type, "label");
    if (r.type === "label") {
      assert.equal(r.product.code, "212");
      assert.equal(r.amount, 5183);
      assert.equal(r.quantity, 1.555);
    }
  });
});

describe("[REAL] Lauda 18/11 (Kretz Report NX2): etiqueta con producto de 5 cifras y peso", () => {
  // La sucursal quedó leyendo la 2-3-7 con importe (la que Patagonia configura con 1070), pero la etiqueta de la NX2
  // trae "21" + PLU 00037 + 01740 g + verificador. Antes se leía como "producto N.º 0".
  const AMOUNT_237 = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" as const };
  const code = "2100037017403";

  it("lee BONDIOLA/ENTERA (37) con 1,740 kg", () => {
    assert.ok(validEan13(code));
    const r = resolveScan(code, [product("37", "Bondiola entera", "kg", 11000)], AMOUNT_237);
    assert.equal(r.type, "label");
    if (r.type === "label") {
      assert.equal(r.product.code, "37");
      assert.equal(r.quantity, 1.74);
      assert.equal(r.amount, undefined);
    }
  });

  it("el código del producto con ceros adelante (\"0037\") también", () => {
    const r = resolveScan(code, [product("0037", "Bondiola entera", "kg", 11000)], AMOUNT_237);
    assert.equal(r.type, "label");
  });

  it("si el producto no existe sigue el aviso de siempre, y un producto por unidad no se toma por kilos", () => {
    assert.equal(resolveScan(code, [product("5", "Otro", "kg", 100)], AMOUNT_237).type, "error");
    assert.equal(resolveScan(code, [product("37", "Bondiola x unidad", "unit", 100)], AMOUNT_237).type, "error");
  });

  it("no cambia nada cuando el formato de la sucursal ya encuentra el producto", () => {
    const M2 = AMOUNT_237;
    const r = resolveScan("2009901890008", [product("99", "Bondiola PifPaf", "kg", 7000)], M2);
    assert.equal(r.type, "label");
    if (r.type === "label") assert.equal(r.amount, 1890);
  });
});

describe("[REAL] Carplat: Report con 2-3-7 y etiqueta por peso (1070 \"2112005\", 18/11/2026)", () => {
  const CARPLAT = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" as const };
  const products = [
    product("67", "ROAST BEEF (ENVASADO)", "kg", 14000),
    product("2", "ENTRAÑA (CAJA)", "kg", 20000),
    product("243", "MILANESAS DE POLLO (3KG)", "kg", 9000),
    product("226", "HUESOS", "unit", 100)
  ];

  it("[REAL] la etiqueta vieja con importe ($88.022,50) se sigue cobrando por su importe", () => {
    const r = resolveScan("2006788022508", products, CARPLAT);
    assert.ok(r.type === "label" && r.product.code === "67" && r.amount === 88022.5);
  });

  it("la etiqueta nueva \"21\" trae los kilos y se cobra con el precio de Patagonia (sin importe)", () => {
    const r = resolveScan("2106700064255", products, CARPLAT); // 6,425 kg
    assert.ok(r.type === "label");
    if (r.type !== "label") return;
    assert.equal(r.product.code, "67");
    assert.equal(r.quantity, 6.425);
    assert.equal(r.amount, undefined);
  });

  it("\"21\" nunca se lee como importe: un código de 3 cifras (243) no cae en el producto 2", () => {
    const r = resolveScan("2124300030005", products, CARPLAT); // 3,000 kg
    assert.ok(r.type === "label" && r.product.code === "243" && r.quantity === 3);
  });

  it("\"21\" con más de 31 kg o de un producto que no existe: error, no se agrega", () => {
    assert.equal(resolveScan("2106700642507", products, CARPLAT).type, "error"); // 64,25 kg
    assert.equal(resolveScan("2199900064255", products, CARPLAT).type, "error"); // N.º 999
  });
});

describe("[REAL] El Abastero 21/11: Kretz con 1-6-5 e importe en pesos enteros", () => {
  // Formato guardado de la sucursal (calibrado el 20/11): prefijo 1, PLU 6, importe 5 en pesos.
  const ABASTERO = { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1, totalLength: 13, payloadType: "amount" as const };
  const products = [product("101", "CAJON DE POLLO FRESCO", "unit", 69000), product("1", "NALGA XKG", "kg", 18333)];

  it("ticket de suma de 3 productos: $68.932 (impreso 68932.10), no $689,32", () => {
    assert.ok(validEan13("2099998689326"));
    const r = resolveScan("2099998689326", products, ABASTERO);
    assert.equal(r.type, "ticket_total");
    if (r.type === "ticket_total") assert.equal(r.amount, 68932);
  });

  it("la etiqueta de un producto se sigue leyendo igual: CAJON DE POLLO $69.000", () => {
    const r = resolveScan("2000101690009", products, ABASTERO);
    assert.equal(r.type, "label");
    if (r.type === "label") {
      assert.equal(r.product.code, "101");
      assert.equal(r.amount, 69000);
    }
  });

  it("suma con el importe en ceros: no se cobra", () => {
    const r = resolveScan(withCheck("209999800000"), products, ABASTERO);
    assert.equal(r.type, "ticket_without_amount");
  });

  it("sin formato de importe guardado sigue la lectura de fábrica (Pollo y mar, 2-5-5 en centavos)", () => {
    const r = resolveScan(withCheck("209999800592"), products, DEFAULT_SCALE_CONFIG);
    assert.equal(r.type, "ticket_total");
    if (r.type === "ticket_total") assert.equal(r.amount, 5.92);
  });
});

describe("ticket de suma con el formato 2-3-7 en centavos guardado (Pollo y mar): igual que antes", () => {
  const AMOUNT_237 = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" as const };
  it("20 998 0210600 = $2.106", () => {
    const r = resolveScan(withCheck("209980210600"), [], AMOUNT_237);
    assert.equal(r.type, "ticket_total");
    if (r.type === "ticket_total") assert.equal(r.amount, 2106);
  });
  it("un 2-5-5 viejo (20 99998 00592) sigue dando $5,92, no $98.005,92", () => {
    const r = resolveScan(withCheck("209999800592"), [], AMOUNT_237);
    assert.equal(r.type, "ticket_total");
    if (r.type === "ticket_total") assert.equal(r.amount, 5.92);
  });
});

it("REAL El Abastero 24/11: con el 1-6-5 de su Report LT se leen sus etiquetas por unidad de 3 cifras y el TOTAL 2-3-7 de su Aura", () => {
  const lt = { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1, totalLength: 13, payloadType: "amount" as const };
  const prods = [
    { id: "n", code: "1", name: "NALGA XKG", unit: "kg", priceRetail: 18333, active: true },
    { id: "f", code: "127", name: "CAJA FORMITA", unit: "u", priceRetail: 42000, active: true }
  ] as unknown as Product[];
  const label = resolveScan("2000127420000", prods, lt);
  assert.equal(label.type, "label");
  if (label.type === "label") {
    assert.equal(label.product.name, "CAJA FORMITA");
    assert.equal(label.quantity, 1);
    assert.equal(label.amount, 42000);
  }
  const total = resolveScan("2099869000007", prods, lt);
  assert.equal(total.type, "ticket_total");
  if (total.type === "ticket_total") assert.equal(total.amount, 69000);
});

describe("[REAL] El Abastero 24/11: etiqueta por kilo con el importe en pesos enteros, se cobra con centavos", () => {
  const ABASTERO = { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1, totalLength: 13, payloadType: "amount" as const };
  const products = [product("17", "FALDA XKG", "kg", 15555), product("15", "MATAMBRE XKG", "kg", 17222), product("1", "NALGA XKG", "kg", 18333), product("127", "CAJA FORMITA", "unit", 42000)];

  for (const [code, name, kg, amount] of [["2000017195216", "FALDA XKG", 1.255, 19521.53], ["2000015216135", "MATAMBRE XKG", 1.255, 21613.61], ["2000001230077", "NALGA XKG", 1.255, 23007.92]] as const) {
    it(`${name}: ${kg} kg, $${amount} como el papel`, () => {
      const r = resolveScan(code, products, ABASTERO);
      assert.equal(r.type, "label");
      if (r.type === "label") {
        assert.equal(r.product.name, name);
        assert.equal(r.quantity, kg);
        assert.equal(r.amount, amount);
      }
    });
  }

  it("por unidad no cambia: CAJA FORMITA $42.000", () => {
    const r = resolveScan("2000127420000", products, ABASTERO);
    assert.ok(r.type === "label" && r.amount === 42000 && r.quantity === 1);
  });

  it("si el precio de Patagonia no coincide con el de la balanza, se cobra el importe del código", () => {
    const caro = [product("17", "FALDA XKG", "kg", 20000)];
    const r = resolveScan("2000017195216", caro, ABASTERO);
    assert.ok(r.type === "label" && r.amount === 19521);
  });

  it("el TOTAL de la Aura (2-3-7 en centavos) sigue siendo un total", () => {
    const r = resolveScan("2099826857002", products, ABASTERO);
    assert.ok(r.type === "ticket_total" && r.amount === 26857);
  });
});

describe("[REAL] El corte argentino 24/11/2026: dos productos con el mismo número (\"1\" Pepas y \"01\" AGUJA)", () => {
  const products = [product("1", "Pepas", "unit", 4100), product("01", "AGUJA", "kg", 12000), product("2", "Polvorones", "unit", 4100), product("02", "ASADO", "kg", 19000), product("09", "CARNE PICADA", "kg", 11000)];
  const label = (plu: string, grams: string) => withCheck(`2${plu}${grams}0`);

  it("una etiqueta con peso del N.º 1 es AGUJA (el único por kg), no Pepas", () => {
    const r = resolveScan(label("00001", "03333"), products, DEFAULT_SCALE_CONFIG);
    assert.equal(r.type, "label");
    if (r.type === "label") {
      assert.equal(r.product.name, "AGUJA");
      assert.equal(r.quantity, 3.333);
    }
  });

  it("sin repetidos, sigue igual (CARNE PICADA 09)", () => {
    const r = resolveScan(label("00009", "03333"), products, DEFAULT_SCALE_CONFIG);
    assert.equal(r.type, "label");
    if (r.type === "label") assert.equal(r.product.name, "CARNE PICADA");
  });

  it("dos repetidos por kg: no adivina y dice cuáles son y qué hacer", () => {
    // Ninguno es exactamente "1" (si uno lo es, gana ese, como siempre).
    const both = [product("01", "AGUJA", "kg", 12000), product("001", "OFERTA AGUJA", "kg", 11000)];
    const r = resolveScan(label("00001", "01000"), both, DEFAULT_SCALE_CONFIG);
    assert.equal(r.type, "error");
    if (r.type === "error") assert.match(r.message, /2 productos con el número 1: AGUJA .* y OFERTA AGUJA .*cambiale el código/);
  });

  it("peso de un producto por unidad sin repetido: dice que revise el código o la unidad, no 'avisá a soporte'", () => {
    const r = resolveScan(label("00002", "01500"), [product("2", "Polvorones", "unit", 4100)], DEFAULT_SCALE_CONFIG);
    assert.equal(r.type, "error");
    if (r.type === "error") {
      assert.match(r.message, /el N\.º 2 es Polvorones, que se vende por unidad/);
      assert.doesNotMatch(r.message, /soporte/);
    }
  });
});

describe("El Abastero 25/11: Aura con inicio 22 en el mismo local que la Report (etiquetas 20 en pesos)", () => {
  const ABASTERO = { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1, totalLength: 13, payloadType: "amount" as const, auraPrefix22: true };
  const products = [product("5", "LOMO XKG", "kg", 18333), product("144", "MILANESA POLLO XKG", "kg", 11000), product("9", "BIFE ANGOSTO XKG", "kg", 18333)];

  it("Pre-Empaque de la Aura: 22 + producto + centavos = producto, kilos e importe exacto", () => {
    const r = resolveScan(withCheck("221440154000"), products, ABASTERO);
    assert.equal(r.type, "label");
    if (r.type === "label") {
      assert.equal(r.product.code, "144");
      assert.equal(r.quantity, 0.14);
      assert.equal(r.amount, 1540);
    }
  });

  it("TOTAL de la Aura con inicio 22 (código 998) es un total en centavos", () => {
    const r = resolveScan(withCheck("229980256600"), products, ABASTERO);
    assert.ok(r.type === "ticket_total" && r.amount === 2566);
  });

  it("el TOTAL con inicio 20 (antes de cambiar la Aura) se sigue leyendo: REAL 2099802566003 = $2.566", () => {
    const r = resolveScan("2099802566003", products, ABASTERO);
    assert.ok(r.type === "ticket_total" && r.amount === 2566);
  });

  it("la etiqueta de la Report (20, pesos) se sigue leyendo igual: BIFE ANGOSTO $27.866,16", () => {
    const r = resolveScan("2000009278668", products, ABASTERO);
    assert.ok(r.type === "label" && r.product.code === "9" && r.amount === 27866.16);
  });

  it("una etiqueta 22 de un producto que no existe: error, no se agrega", () => {
    const r = resolveScan(withCheck("227770154000"), products, ABASTERO);
    assert.equal(r.type, "error");
  });

  it("sin la marca, un 22 no se lee como Aura", () => {
    const { auraPrefix22: _x, ...plain } = ABASTERO;
    const r = resolveScan(withCheck("221440154000"), products, plain);
    assert.notEqual(r.type, "label");
  });
});
