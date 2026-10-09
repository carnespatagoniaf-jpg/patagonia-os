import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { DEFAULT_SCALE_CONFIG } from "./scale-barcode";
import { compareScaleControl, describeScaleTicket, parseScaleAmount, parseScaleKg, suggestScaleCorrection, type ScaleControlTotals } from "./scale-control";

function withCheckDigit(first12: string): string {
  const sum = first12.split("").reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + String((10 - (sum % 10)) % 10);
}

const totals = (over: Partial<ScaleControlTotals> = {}): ScaleControlTotals => ({
  systemAmount: 6500, systemKg: 1.5, systemTickets: 3, voidedAmount: 1500, voidedKg: 1.5, voidedTickets: 1, shiftCount: 1, ...over
});

describe("control de balanza en el cierre", () => {
  it("coincide: balanza − anulados = cobrado en Mostrador", () => {
    const r = compareScaleControl({ amount: 8000, kg: 3, tickets: 4 }, totals());
    assert.equal(r.expectedAmount, 6500);
    assert.equal(r.amountDiff, 0);
    assert.equal(r.kgDiff, 0);
    assert.equal(r.ticketsDiff, 0);
    assert.equal(r.ok, true);
  });

  it("faltan cobrar: la balanza imprimió más de lo que pasó por Mostrador", () => {
    const r = compareScaleControl({ amount: 12000, kg: null, tickets: 6 }, totals());
    assert.equal(r.amountDiff, -4000);
    assert.equal(r.ticketsDiff, -2);
    assert.equal(r.kgDiff, null);
    assert.equal(r.ok, false);
  });

  it("menos de un peso de diferencia (redondeo) cuenta como que coincide", () => {
    assert.equal(compareScaleControl({ amount: 8000.4, kg: null, tickets: null }, totals()).ok, true);
  });
});

describe("leer el ticket para anularlo", () => {
  const nalga = { id: "p1", code: "12", name: "Nalga", unit: "kg", priceRetail: 10000 } as unknown as Product;

  it("etiqueta de peso: importe al precio del sistema", () => {
    const t = describeScaleTicket(withCheckDigit("200012012500"), DEFAULT_SCALE_CONFIG, [nalga]);
    assert.deepEqual(t, { kind: "label", plu: "12", product: nalga, weightKg: 1.25, amount: 12500 });
  });

  it("ticket de total de la balanza", () => {
    assert.deepEqual(describeScaleTicket("0000014550003", DEFAULT_SCALE_CONFIG, [nalga]), { kind: "total", amount: 14550 });
  });

  it("código que no es de balanza", () => {
    assert.equal(describeScaleTicket("7790001234567", DEFAULT_SCALE_CONFIG, [nalga]), null);
    assert.equal(describeScaleTicket("", DEFAULT_SCALE_CONFIG, [nalga]), null);
  });
});

describe("números copiados del TOTAL DEL DIA de la balanza", () => {
  it("lee el importe con el punto decimal de la balanza (caso real 962812.52$)", () => {
    assert.equal(parseScaleAmount("962812.52"), 962812.52);
    assert.equal(parseScaleAmount("962812.52$"), 962812.52);
    assert.equal(parseScaleAmount("962.812,52"), 962812.52);
    assert.equal(parseScaleAmount("962.812"), 962812);
    assert.equal(parseScaleAmount("962812"), 962812);
    assert.equal(parseScaleAmount("1728.5"), 1728.5);
    assert.ok(Number.isNaN(parseScaleAmount("")));
  });

  it("lee los kilos como los imprime la balanza", () => {
    assert.equal(parseScaleKg("85.112kg"), 85.112);
    assert.equal(parseScaleKg("85,112"), 85.112);
  });

  it("sugiere corregir cuando se perdió el punto (casos reales de Carnes Patagonia)", () => {
    assert.equal(suggestScaleCorrection(96281252, 881218.52, 100), 962812.52);
    assert.equal(suggestScaleCorrection(66406790, 645660.75, 100), 664067.9);
    assert.equal(suggestScaleCorrection(85112, 82.924, 1000), 85.112);
    // Números razonables: no se toca.
    assert.equal(suggestScaleCorrection(962812.52, 881218.52, 100), null);
    assert.equal(suggestScaleCorrection(1832735.24, 1053400.25, 100), null);
    // Sin ventas en Mostrador no hay con qué comparar.
    assert.equal(suggestScaleCorrection(96281252, 0, 100), null);
  });
});
