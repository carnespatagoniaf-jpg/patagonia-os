import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeAuraDevice, REAL_CLIENT_RECORDS } from "./aura-fake-device";
import { buildKretzFrame, parseKretzResponse } from "./kretz-frame";

const hex = (s: string) => s.split(" ").map((h) => parseInt(h, 16));

describe("Aura de mentira para capturar iTegra", () => {
  it("contesta 0001 y 1500 con los MISMOS bytes que la Aura real", () => {
    const d = new FakeAuraDevice();
    assert.deepEqual(d.receive(buildKretzFrame("H", "01", "0001")), hex("07 48 30 31 30 30 30 31 37 31 04"));
    assert.deepEqual(
      d.receive(buildKretzFrame("H", "01", "1500")),
      hex("07 48 30 31 30 30 30 31 41 55 49 2d 30 33 30 4b 4d 46 42 41 50 50 34 4b 41 52 20 20 56 31 2e 30 30 20 20 36 46 65 62 32 34 20 30 30 20 20 20 20 20 20 20 3c 31 04")
    );
  });

  it("5005 recorre los 6 productos reales y termina con el código 40, igual que la real", () => {
    const d = new FakeAuraDevice();
    assert.deepEqual(d.receive(buildKretzFrame("H", "01", "5005", "000000")), hex("07 48 30 31 30 35 30 31 30 30 30 30 30 31 46 52 55 54 49 4c 4c 41 20 20 20 20 20 20 20 20 50 30 30 30 30 31 30 30 30 31 30 35 30 30 30 30 30 30 30 35 3e 36 04"));
    assert.equal(parseKretzResponse(d.receive(buildKretzFrame("H", "01", "5005", "000011")))?.code, "40");
  });

  it("2005 guarda el registro TAL CUAL (para ver qué manda iTegra) y lo registra byte por byte", () => {
    const d = new FakeAuraDevice();
    const rec = "000050HUEVO           N0005000003000000000";
    const r = parseKretzResponse(d.receive(buildKretzFrame("H", "01", "2005", rec)));
    assert.equal(r?.group, "05");
    assert.equal(r?.code, "01");
    assert.ok(d.records.includes(rec));
    const e = d.log.at(-1)!;
    assert.equal(e.frame?.command, "2005");
    assert.equal(e.frame?.data, rec);
    assert.match(e.note, /42 caracteres/);
  });

  it("cualquier otro comando queda registrado y se contesta 'inexistente' (00 02), como la real", () => {
    const d = new FakeAuraDevice();
    const r = parseKretzResponse(d.receive(buildKretzFrame("H", "01", "1070", "2012011")));
    assert.equal(r?.group, "00");
    assert.equal(r?.code, "02");
    assert.equal(d.log.at(-1)?.frame?.command, "1070");
    assert.deepEqual(d.records, REAL_CLIENT_RECORDS, "no cambia nada");
  });

  it("arma la trama aunque llegue en pedazos, y registra bytes sueltos", () => {
    const d = new FakeAuraDevice();
    const f = Array.from(buildKretzFrame("H", "01", "0001"));
    assert.deepEqual(d.receive(f.slice(0, 4)), []);
    assert.equal(parseKretzResponse(d.receive(f.slice(4)))?.code, "01");
    d.receive([0x41, 0x42]);
    d.receive([0x02]);
    assert.ok(d.log.some((e) => e.note.startsWith("bytes")));
  });
});
