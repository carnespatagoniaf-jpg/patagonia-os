import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWeightBarcode } from "../../sale/scale-barcode";
import { buildAuraPluRecord, parseAuraPlu, type AuraTypeLetter } from "./aura-plu";
import { compareAuraRecords } from "./aura-write-test";
import { buildKretzFrame, parseKretzResponse } from "./kretz-frame";

/*
 * Tramas REALES de la Aura de la clienta "Pollo y mar" (AUI-030KMFBAPP4KAR,
 * firmware V1.00 6Feb24), copiadas byte por byte del informe de soporte del
 * 2026-10-02 12:59 (scale_support_reports, auraWriteTest.exchanges).
 */
const hex = (s: string) => new Uint8Array(s.trim().split(/\s+/).map((h) => parseInt(h, 16)));

/** Respuestas reales a 5005 (leer el siguiente PLU), en orden. */
const REAL_5005_RESPONSES = [
  "07 48 30 31 30 35 30 31 30 30 30 30 30 31 46 52 55 54 49 4c 4c 41 20 20 20 20 20 20 20 20 50 30 30 30 30 31 30 30 30 31 30 35 30 30 30 30 30 30 30 35 3e 36 04",
  "07 48 30 31 30 35 30 31 30 30 30 30 30 32 50 41 53 54 45 4c 49 54 4f 53 20 20 20 20 20 20 4e 30 30 30 30 32 30 30 30 30 30 39 30 30 30 30 30 30 30 33 34 3c 04",
  "07 48 30 31 30 35 30 31 30 30 30 30 30 33 50 41 4e 20 4e 45 47 52 4f 20 20 20 20 20 20 20 50 30 30 30 30 33 30 30 30 30 34 38 30 30 31 30 30 30 30 31 3e 34 04",
  "07 48 30 31 30 35 30 31 30 30 30 30 30 36 4d 49 4c 41 20 42 45 52 45 4e 4a 45 4e 41 20 20 44 30 30 30 30 36 30 30 30 35 32 30 30 30 30 30 30 30 30 30 38 3a 04",
  "07 48 30 31 30 35 30 31 30 30 30 30 30 38 50 52 4f 4d 4f 20 20 20 20 20 20 20 20 20 20 20 43 30 30 30 30 38 30 30 31 38 39 30 30 30 30 30 30 30 30 30 37 38 04",
  "07 48 30 31 30 35 30 31 30 30 30 30 31 31 48 41 4d 42 20 50 4f 4c 4c 4f 20 20 20 20 20 20 44 30 30 30 31 31 30 30 31 30 38 30 30 30 30 30 30 30 30 30 3f 35 04"
];
const CLIENT_RECORDS = [
  "000001FRUTILLA        P0000100010500000005",
  "000002PASTELITOS      N0000200000900000003",
  "000003PAN NEGRO       P0000300004800100001",
  "000006MILA BERENJENA  D0000600052000000000",
  "000008PROMO           C0000800189000000000",
  "000011HAMB POLLO      D0001100108000000000"
];

/** Lo que mandamos con 2005 para el PLU 97 y lo que la balanza contestó y guardó. */
const REAL_2005_TX_97 =
  "02 48 30 31 32 30 30 35 30 30 30 30 39 37 50 52 55 45 42 41 20 4b 49 4c 4f 20 20 20 20 20 50 30 30 30 39 37 30 30 30 32 30 30 30 30 30 30 30 30 30 32 34 34 04";
const REAL_2005_RX_97 = "07 48 30 31 30 35 30 31 37 36 04";
const REAL_READBACK_97 =
  "07 48 30 31 30 35 30 31 30 30 30 30 39 37 50 52 55 45 42 41 20 4b 49 4c 4f 20 20 20 20 20 44 30 30 30 30 30 30 30 30 32 30 30 30 30 30 30 30 30 30 32 32 3c 04";
/** Fin de la lista: grupo 05, código 40. */
const REAL_END_OF_LIST = "07 48 30 31 30 35 34 30 37 39 04";

/** Los 4 pares mandado → guardado de la segunda prueba (2026-10-02 12:59). */
const WRITE_PAIRS: [string, string][] = [
  ["000097PRUEBA KILO     P0009700020000000002", "000097PRUEBA KILO     D0000000020000000002"],
  ["000098PRUEBA UNIDAD   C0009800005000000000", "000098PRUEBA UNIDAD   D0000000005000000000"],
  ["000096PRUEBA UNIDAD V N0009600003000000003", "000096PRUEBA UNIDAD V D0000000003000000003"],
  ["000099PRUEBA PATAGONIAD0050000012340000000", "000099PRUEBA PATAGONIAD0000000012340000000"]
];

/**
 * Modelo de lo OBSERVADO en la Aura real con 2005 (2 pruebas, 5 escrituras):
 * guarda nombre, precio, tara y validez tal cual; la posición 22 siempre queda
 * "D" y las 23-28 siempre "000000", se mande lo que se mande. No es el
 * protocolo (no está publicado): es lo que la balanza hizo.
 */
function observedAuraStore(sent: string): string {
  return sent.slice(0, 22) + "D" + "000000" + sent.slice(29);
}

describe("tramas reales de la Aura de la clienta", () => {
  it("las 6 respuestas reales a 5005 tienen checksum correcto y dan exactamente los 6 productos", () => {
    const got = REAL_5005_RESPONSES.map((h) => {
      const r = parseKretzResponse(Array.from(hex(h)));
      assert.ok(r, h);
      assert.equal(r.checksumOk, true);
      assert.equal(r.deviceType, "H");
      assert.equal(r.equipmentId, "01");
      assert.equal(r.code, "01");
      return r.data;
    });
    assert.deepEqual(got, CLIENT_RECORDS);
    const end = parseKretzResponse(Array.from(hex(REAL_END_OF_LIST)));
    assert.equal(end?.checksumOk, true);
    assert.equal(end?.code, "40");
  });

  it("los 6 productos originales se separan en campos y se vuelven a armar idénticos (6+16+1+6+6+4+3)", () => {
    for (const rec of CLIENT_RECORDS) {
      const p = parseAuraPlu(rec)!;
      assert.equal(p.code, String(p.plu * 10).padStart(6, "0"), `${p.name}: código = PLU seguido de 0`);
      assert.equal(buildAuraPluRecord({ plu: p.plu, name: p.name, type: p.type as AuraTypeLetter, priceRaw: Number(p.priceRaw), tareGrams: Number(p.tareRaw), validityDays: p.validityDays }), rec);
    }
  });

  it("la trama 2005 que salió a la balanza es exactamente la que arma el código hoy", () => {
    const sent = WRITE_PAIRS[0][0];
    assert.deepEqual(Array.from(buildKretzFrame("H", "01", "2005", sent)), Array.from(hex(REAL_2005_TX_97)));
    const ack = parseKretzResponse(Array.from(hex(REAL_2005_RX_97)));
    assert.equal(ack?.checksumOk, true);
    assert.equal(ack?.code, "01");
    const back = parseKretzResponse(Array.from(hex(REAL_READBACK_97)));
    assert.equal(back?.data, WRITE_PAIRS[0][1]);
  });

  it("en las 4 escrituras, lo único que cambió fue la letra (→ D) y el código (→ 0); el modelo observado lo reproduce", () => {
    for (const [sent, stored] of WRITE_PAIRS) {
      assert.equal(observedAuraStore(sent), stored);
      const same = compareAuraRecords(sent, stored)!;
      assert.equal(same.nombre && same.precio && same.tara && same.validez, true);
    }
  });

  it("con lo observado, reescribir cualquier producto de la clienta le cambiaría el código (y a 4 de 6, la letra): el envío masivo tiene que seguir bloqueado", () => {
    const altered = CLIENT_RECORDS.filter((rec) => observedAuraStore(rec) !== rec);
    assert.equal(altered.length, 6);
    const letterChanged = CLIENT_RECORDS.filter((rec) => observedAuraStore(rec)[22] !== rec[22]).map((rec) => parseAuraPlu(rec)!.name);
    assert.deepEqual(letterChanged, ["FRUTILLA", "PASTELITOS", "PAN NEGRO", "PROMO"]);
  });

  it("código de barras real de los dos tickets (2099998000008): EAN-13 válido, no trae producto ni importe", () => {
    const code = "2099998000008";
    const d = code.split("").map(Number);
    const check = (10 - (d.slice(0, 12).reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0) % 10)) % 10;
    assert.equal(check, d[12]);
    // Leído como formato 2-5-5 del manual (§7.1.7): inicio "20", código "99998" (código suma de un ticket), valor "00000".
    assert.deepEqual([code.slice(0, 2), code.slice(2, 7), code.slice(7, 12)], ["20", "99998", "00000"]);
    // Mostrador no puede sacar nada de ahí: el valor es 0 con cualquier formato de peso o importe.
    assert.equal(parseWeightBarcode(code, { prefixLength: 2, pluLength: 5, weightLength: 5, weightDivisor: 1000, totalLength: 13, payloadType: "weight" }), null);
    assert.equal(parseWeightBarcode(code, { prefixLength: 2, pluLength: 5, weightLength: 5, weightDivisor: 1, totalLength: 13, payloadType: "amount" }), null);
  });
});
