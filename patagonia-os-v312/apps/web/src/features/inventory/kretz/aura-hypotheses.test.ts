import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidEan13, parseAuraBarcode } from "./aura-barcode";
import { HYPOTHESES, evaluateHypotheses, type WriteObservation } from "./aura-hypotheses";
import { planAuraPriceUpdate } from "./aura-sync-plan";

/** Las 5 escrituras reales (2026-10-02 12:02 y 12:59): mandado → releído con 5005. */
const OBSERVED: WriteObservation[] = [
  { sent: "000099PRUEBA PATAGONIAP0009900012340000000", stored: "000099PRUEBA PATAGONIAD0000000012340000000" },
  { sent: "000097PRUEBA KILO     P0009700020000000002", stored: "000097PRUEBA KILO     D0000000020000000002" },
  { sent: "000098PRUEBA UNIDAD   C0009800005000000000", stored: "000098PRUEBA UNIDAD   D0000000005000000000" },
  { sent: "000096PRUEBA UNIDAD V N0009600003000000003", stored: "000096PRUEBA UNIDAD V D0000000003000000003" },
  { sent: "000099PRUEBA PATAGONIAD0050000012340000000", stored: "000099PRUEBA PATAGONIAD0000000012340000000" }
];

const CLIENT = [
  "000001FRUTILLA        P0000100010500000005",
  "000002PASTELITOS      N0000200000900000003",
  "000003PAN NEGRO       P0000300004800100001",
  "000006MILA BERENJENA  D0000600052000000000",
  "000008PROMO           C0000800189000000000",
  "000011HAMB POLLO      D0001100108000000000"
];

describe("simulador de hipótesis de escritura (2005) contra las 5 escrituras reales", () => {
  it("descarta las que no explican lo que pasó y deja solo dos posibles", () => {
    const r = Object.fromEntries(evaluateHypotheses(OBSERVED).map((x) => [x.id, x]));
    assert.equal(r["H0-directa"].consistent, false); // guardar tal cual: NO
    assert.equal(r["H1-validez"].consistent, false); // letra según validez: NO
    assert.equal(r["H4-letra-deriva-del-codigo"].consistent, false); // N → C: NO
    assert.equal(r["H2-orden-nx"].consistent, true); // orden código→tipo al escribir: posible
    assert.equal(r["H3-ignora"].consistent, true); // la balanza no toma letra ni código: posible
  });

  it("la captura de iTegra decide entre las dos: el formato oficial es H2 (código antes del tipo)", () => {
    const h2 = HYPOTHESES.find((h) => h.id === "H2-orden-nx")!;
    const h3 = HYPOTHESES.find((h) => h.id === "H3-ignora")!;
    const itegra = "000051PRUEBA UNIDAD   000051N0500000000000"; // 2005 que mandó iTegra (oficial)
    assert.equal(h2.store(itegra), "000051PRUEBA UNIDAD   N0000510500000000000"); // H2: queda por unidad con su código
    assert.equal(h3.store(itegra), "000051PRUEBA UNIDAD   D0000000500000000000"); // H3: el programa oficial no podría cargar productos por unidad
    assert.equal(h2.unitProductWith97!(OBSERVED[2].sent), "000098PRUEBA UNIDAD   000097N0005000000000");
  });
});

describe("plan de precios con el formato de iTegra (sin enviar nada)", () => {
  const updates = [
    { plu: 1, priceRaw: 1100, byWeight: true },
    { plu: 2, priceRaw: 100, byWeight: false },
    { plu: 3, priceRaw: 500, byWeight: true },
    { plu: 6, priceRaw: 5500, byWeight: true },
    { plu: 8, priceRaw: 19000, byWeight: false },
    { plu: 11, priceRaw: 10800, byWeight: true },
    { plu: 12, priceRaw: 9000, byWeight: true, name: "Pechuga", code: 1200 },
    { plu: 13, priceRaw: 300, byWeight: false, name: "Huevo" }
  ];
  const plan = Object.fromEntries(planAuraPriceUpdate(CLIENT, updates).map((p) => [p.plu, p]));

  it("P y N se actualizan conservando su código y tipo; D y C se marcan para revisar; los nuevos se crean por kilo o por unidad", () => {
    assert.equal(plan[1].action, "actualizar");
    assert.equal(plan[2].action, "actualizar");
    assert.equal(plan[3].action, "actualizar");
    assert.equal(plan[6].action, "revisar");
    assert.equal(plan[8].action, "revisar");
    assert.equal(plan[11].action, "sin_cambios");
    assert.equal(plan[12].action, "crear");
    assert.equal(plan[13].action, "crear");
  });

  it("FRUTILLA y PASTELITOS: cambia solo el precio; al releer se espera el mismo tipo, código, tara y validez", () => {
    assert.equal(plan[1].record, "000001FRUTILLA        000010P0011000000005");
    assert.equal(plan[1].expectedReadBack, "000001FRUTILLA        P0000100011000000005");
    assert.equal(plan[2].expectedReadBack, "000002PASTELITOS      N0000200001000000003");
  });

  it("producto nuevo: por kilo con código propio, y por unidad con el código igual al PLU", () => {
    assert.equal(plan[12].record, "000012PECHUGA         001200P0090000000000");
    assert.equal(plan[13].record, "000013HUEVO           000013N0003000000000");
  });
});

describe("código de barras de los tickets de la Aura", () => {
  it("el código real de los dos tickets es EAN-13 válido y, como 2-5-5, es un ticket de suma SIN importe", () => {
    assert.equal(isValidEan13("2099998000008"), true);
    assert.deepEqual(parseAuraBarcode("2099998000008", { format: "2-5-5", sumCode: 99998, amountDivisor: 1 }), { kind: "suma", prefix: "20", amount: null });
  });

  it("si la balanza se configura con importe (PESO = NO), el mismo ticket traería el total (ejemplo armado, sin confirmar con un ticket real)", () => {
    // 20 + 99998 + 01394 + verificador. Si el importe viniera con decimales, se calibra amountDivisor con un ticket real.
    const body = "209999801394";
    const check = (10 - (body.split("").map(Number).reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0) % 10)) % 10;
    const code = body + check;
    assert.deepEqual(parseAuraBarcode(code, { format: "2-5-5", sumCode: 99998, amountDivisor: 1 }), { kind: "suma", prefix: "20", amount: 1394 });
  });

  it("rechaza códigos con verificador inválido", () => {
    assert.equal(parseAuraBarcode("2099998000006", { format: "2-5-5", sumCode: 99998, amountDivisor: 1 }), null);
  });
});
