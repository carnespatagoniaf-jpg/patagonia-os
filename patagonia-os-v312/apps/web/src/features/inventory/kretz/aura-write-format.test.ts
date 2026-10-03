import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auraWriteToReadOrder, buildAuraWriteRecord, rewriteWithNewPrice } from "./aura-plu";

/** Registros 2005 que mandó iTegra (oficial) a la Aura simulada, 2026-10-02 (docs/capturas/aura-itegra-2026-10-02.json). */
const ITEGRA = {
  kilo: "000050PRUEBA KILO     000050P1234000000005",
  unidad: "000051PRUEBA UNIDAD   000051N0500000000000",
  codigo: "000052PRUEBA CODIGO   000777P0999000000000",
  uniCod: "000053PRUEBA UNI COD  000888N0300000000003",
  cambioPrecio: "000050PRUEBA KILO     000050P1300000000005"
};

/** Los 6 productos reales de la clienta, leídos con 5005. */
const CLIENT = [
  "000001FRUTILLA        P0000100010500000005",
  "000002PASTELITOS      N0000200000900000003",
  "000003PAN NEGRO       P0000300004800100001",
  "000006MILA BERENJENA  D0000600052000000000",
  "000008PROMO           C0000800189000000000",
  "000011HAMB POLLO      D0001100108000000000"
];

describe("formato de escritura de la Aura (capturado de iTegra)", () => {
  it("arma el registro con el mismo orden que iTegra: código (6) antes del tipo (P/N)", () => {
    // iTegra manda el precio con 2 decimales (1234 → 123400). Pasándole ese mismo número, el registro es idéntico.
    assert.equal(buildAuraWriteRecord({ plu: 50, name: "Prueba kilo", type: "P", code: 50, priceRaw: 123400, validityDays: 5 }), ITEGRA.kilo);
    assert.equal(buildAuraWriteRecord({ plu: 51, name: "Prueba unidad", type: "N", code: 51, priceRaw: 50000 }), ITEGRA.unidad);
    assert.equal(buildAuraWriteRecord({ plu: 52, name: "Prueba codigo", type: "P", code: 777, priceRaw: 99900 }), ITEGRA.codigo);
    assert.equal(buildAuraWriteRecord({ plu: 53, name: "Prueba uni cod", type: "N", code: 888, priceRaw: 30000, validityDays: 3 }), ITEGRA.uniCod);
  });

  it("explica las 5 escrituras reales: con el orden de lectura, la Aura veía una letra donde va el código", () => {
    const sentByUs = "000097PRUEBA KILO     P0009700020000000002"; // lo que mandamos el 2026-10-02
    assert.match(sentByUs.slice(22, 28), /[^0-9]/);
    assert.match(sentByUs[28], /[0-9]/);
    const ok = buildAuraWriteRecord({ plu: 97, name: "Prueba kilo", type: "P", code: 97, priceRaw: 2000, validityDays: 2 });
    assert.match(ok.slice(22, 28), /^\d{6}$/);
    assert.equal(ok[28], "P");
  });

  it("al leer, la Aura devuelve el tipo primero y el código en 5 dígitos + 0 (REAL, 2026-10-03 18:03)", () => {
    const sent = "000097PRUEBA KILO     000097P0020000000002";
    const readOnTheRealScale = "000097PRUEBA KILO     P0009700020000000002";
    assert.equal(buildAuraWriteRecord({ plu: 97, name: "Prueba kilo", type: "P", code: 97, priceRaw: 2000, validityDays: 2 }), sent);
    assert.equal(auraWriteToReadOrder(sent), readOnTheRealScale);
    // Con la misma regla, PASTELITOS (código 2 en iTegra) se lee igual que en la balanza.
    assert.equal(auraWriteToReadOrder(buildAuraWriteRecord({ plu: 2, name: "Pastelitos", type: "N", code: 2, priceRaw: 90, validityDays: 3 })), CLIENT[1]);
  });

  it("cambio de precio: igual que iTegra, reenvía el registro completo con el mismo código y tipo", () => {
    assert.equal(rewriteWithNewPrice(auraWriteToReadOrder(ITEGRA.kilo), 130000), ITEGRA.cambioPrecio);
  });

  it("cambio de precio de los productos de la clienta: P y N conservan código, tipo, tara y validez; D y C no se tocan", () => {
    const frutilla = rewriteWithNewPrice(CLIENT[0], 1100)!;
    assert.equal(frutilla, "000001FRUTILLA        000001P0011000000005", "FRUTILLA conserva el código 1");
    assert.equal(auraWriteToReadOrder(frutilla), "000001FRUTILLA        P0000100011000000005");
    assert.equal(auraWriteToReadOrder(rewriteWithNewPrice(CLIENT[2], 500)!), "000003PAN NEGRO       P0000300005000100001", "tara 100 g y 1 día se conservan");
    assert.equal(rewriteWithNewPrice(CLIENT[1], 100)![28], "N", "sigue por unidad");
    assert.equal(rewriteWithNewPrice(CLIENT[3], 5500), null);
    assert.equal(rewriteWithNewPrice(CLIENT[4], 19000), null);
  });

  it("frena datos inválidos", () => {
    assert.throws(() => buildAuraWriteRecord({ plu: 1, name: "X", type: "D" as "P", code: 1, priceRaw: 1 }));
    assert.throws(() => buildAuraWriteRecord({ plu: 1, name: "X", type: "P", code: 100000, priceRaw: 1 }));
    assert.throws(() => buildAuraWriteRecord({ plu: 1, name: "X", type: "P", code: 1, priceRaw: 1000000 }));
  });
});
