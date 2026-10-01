import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AURA_PLU_LAYOUT, AURA_PLU_RECORD_LENGTH, auraPriceCandidates, parseAuraPlu } from "./aura-plu";

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
