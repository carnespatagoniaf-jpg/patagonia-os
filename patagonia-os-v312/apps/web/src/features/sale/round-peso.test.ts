import { test } from "node:test";
import assert from "node:assert/strict";
import { lineGross, roundToPeso } from "./sale-model";

test("1,035 kg × $14.300 = $14.800,50 se cobra $14.801, igual que el servidor", () => {
  const gross = lineGross({ quantity: 1.035, unitPrice: 14300 });
  assert.equal(roundToPeso(gross), 14801);
});

test("redondea normal lo que no está justo en ,50", () => {
  assert.equal(roundToPeso(14800.49), 14800);
  assert.equal(roundToPeso(14800.51), 14801);
  assert.equal(roundToPeso(0.1 + 0.2), 0);
  assert.equal(roundToPeso(0), 0);
});

test("otros pesos que caen en ,50 con error de coma flotante", () => {
  // Cuentas que en el servidor dan ,50 exacto: la pantalla tiene que coincidir.
  for (const [kg, price] of [[1.035, 14300], [0.335, 8100], [2.215, 9900], [0.505, 7100]] as const) {
    const exactCents = Math.round(kg * 1000) * price; // milésimas de peso, entero exacto
    const expected = Math.floor((exactCents + 500) / 1000);
    assert.equal(roundToPeso(lineGross({ quantity: kg, unitPrice: price })), expected, `${kg} × ${price}`);
  }
});
