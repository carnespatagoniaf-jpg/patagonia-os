import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildKretzFrame, describeKretzCode, kretzChecksum, parseKretzResponse, toHex } from "./kretz-frame";

describe("trama Kretz (documento público Report Nx)", () => {
  it("checksum: el ejemplo del documento (0x02+'C'+'01'+'0001' = 0x167 → \"67\")", () => {
    const bytes = [0x02, 0x43, 0x30, 0x31, 0x30, 0x30, 0x30, 0x31];
    assert.deepEqual(kretzChecksum(bytes).map((b) => String.fromCharCode(b)).join(""), "67");
  });

  it("arma el test de conexión 0001 como lo manda Patagonia OS a la Report LT real", () => {
    assert.equal(toHex(buildKretzFrame("C", "01", "0001")), "02 43 30 31 30 30 30 31 36 37 04");
  });

  it("lee la respuesta real de la Report LT (07 43 30 31 30 35 30 31 37 31 04)", () => {
    const r = parseKretzResponse([0x07, 0x43, 0x30, 0x31, 0x30, 0x35, 0x30, 0x31, 0x37, 0x31, 0x04]);
    assert.ok(r);
    assert.equal(r.deviceType, "C");
    assert.equal(r.equipmentId, "01");
    assert.equal(r.group, "05");
    assert.equal(r.code, "01");
    assert.equal(r.checksumOk, true);
    assert.equal(describeKretzCode(r.code), "comando ejecutado correctamente");
  });

  it("no confunde ruido con una respuesta Kretz", () => {
    assert.equal(parseKretzResponse([0xff, 0x13, 0x88, 0x04]), null);
    assert.equal(parseKretzResponse(new TextEncoder().encode("2,01.234,\r")), null);
  });

  it("marca el checksum malo", () => {
    const r = parseKretzResponse([0x07, 0x43, 0x30, 0x31, 0x30, 0x35, 0x30, 0x31, 0x30, 0x30, 0x04]);
    assert.equal(r?.checksumOk, false);
  });
});
