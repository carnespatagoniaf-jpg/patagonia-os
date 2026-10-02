import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AURA_PLU_LAYOUT, AURA_PLU_RECORD_LENGTH, auraPriceCandidates, auraTypeLetter, buildAuraPluRecord, parseAuraPlu, type AuraTypeLetter } from "./aura-plu";

describe("PLU de la Kretz Aura (registro real de 5005)", () => {
  const REAL = "000001FRUTILLA        P0000100010500000005"; // Aura AUI-030KMFBAPP4KAR, 2026-10-01

  it("el reparto supuesto suma exactamente el largo del registro real", () => {
    assert.equal(REAL.length, AURA_PLU_RECORD_LENGTH);
    assert.equal(AURA_PLU_LAYOUT.reduce((s, [, w]) => s + w, 0), AURA_PLU_RECORD_LENGTH);
  });

  it("separa el registro real", () => {
    const r = parseAuraPlu(REAL);
    assert.ok(r);
    assert.equal(r.plu, 1);
    assert.equal(r.name, "FRUTILLA");
    assert.equal(r.type, "P");
    assert.equal(r.code, "000010");
    assert.equal(r.priceRaw, "001050");
    assert.equal(r.tareRaw, "0000");
    assert.equal(r.validityDays, 5);
    assert.deepEqual(auraPriceCandidates(r.priceRaw), { sinDecimales: 1050, conDosDecimales: 10.5 });
  });

  it("no acepta registros de otro largo", () => {
    assert.equal(parseAuraPlu(REAL.slice(1)), null);
    assert.equal(parseAuraPlu("AUI-030KMFBAPP4KAR  V1.00  6Feb24 00       "), null);
  });
});

describe("armado del registro de la Aura", () => {
  const REAL_SIX = [
    "000001FRUTILLA        P0000100010500000005",
    "000002PASTELITOS      N0000200000900000003",
    "000003PAN NEGRO       P0000300004800100001",
    "000006MILA BERENJENA  D0000600052000000000",
    "000008PROMO           C0000800189000000000",
    "000011HAMB POLLO      D0001100108000000000"
  ];

  it("arma byte por byte igual que los 6 registros reales de la balanza", () => {
    for (const real of REAL_SIX) {
      const r = parseAuraPlu(real)!;
      const built = buildAuraPluRecord({ plu: r.plu, name: r.name, type: r.type as AuraTypeLetter, priceRaw: Number(r.priceRaw), tareGrams: Number(r.tareRaw), validityDays: r.validityDays });
      assert.equal(built, real);
    }
  });

  it("la letra (hipótesis H1) explica los 6 reales y el cambio P→D del PLU 99", () => {
    const sold = { FRUTILLA: true, PASTELITOS: false, "PAN NEGRO": true, "MILA BERENJENA": true, PROMO: false, "HAMB POLLO": true } as Record<string, boolean>;
    for (const real of REAL_SIX) {
      const r = parseAuraPlu(real)!;
      assert.equal(auraTypeLetter(sold[r.name], r.validityDays), r.type, r.name);
    }
    assert.equal(auraTypeLetter(true, 0), "D"); // PLU 99: mandamos P sin validez y la balanza lo guardó como D
  });

  it("el primer producto de prueba (el que se mandó el 2026-10-02)", () => {
    assert.equal(buildAuraPluRecord({ plu: 99, name: "Prueba Patagonia", type: "P", priceRaw: 1234 }), "000099PRUEBA PATAGONIAP0009900012340000000");
  });

  it("frena datos fuera de rango", () => {
    assert.throws(() => buildAuraPluRecord({ plu: 0, name: "X", type: "P", priceRaw: 1 }));
    assert.throws(() => buildAuraPluRecord({ plu: 10000, name: "X", type: "P", priceRaw: 1 }));
    assert.throws(() => buildAuraPluRecord({ plu: 5, name: "X", type: "P", priceRaw: 1000000 }));
    assert.throws(() => buildAuraPluRecord({ plu: 5, name: "X", type: "P", priceRaw: 10.5 }));
  });
});
