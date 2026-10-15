import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTotalsRecord } from "./aura-totals-probe";
import { isReadOnlyCommand } from "./discovery";

describe("[DOCUMENTADO] totales por producto de la Kretz (5008, solo lectura)", () => {
  it("lee el registro del ejemplo del Multiprotocolo Report Nx R30 (C0108010000012211050400000025…)", () => {
    const frame = "C0108010000012211050400000025000011111000022222000033333000044444";
    const r = parseTotalsRecord(frame.slice(7));
    assert.deepEqual(r, { plu: 1, date: "221105", range: "04", sales: 25, amount: 11111, quantity: 22222 });
  });

  it("solo manda órdenes de lectura: 5008/5001/5009 sí; 3008/4008 (borran totales) nunca", () => {
    assert.ok(isReadOnlyCommand("5008") && isReadOnlyCommand("5001") && isReadOnlyCommand("5009"));
    assert.equal(isReadOnlyCommand("3008"), false);
    assert.equal(isReadOnlyCommand("4008"), false);
  });

  it("una respuesta con otra forma no se interpreta", () => {
    assert.equal(parseTotalsRecord("Inexistente"), null);
  });
});
