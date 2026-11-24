import assert from "node:assert/strict";
import { it } from "node:test";
import { formatMoneyCents } from "./format";

const clean = (s: string) => s.replace(/\s/g, " ");

it("REAL El Abastero 24/11: la línea de la etiqueta muestra los centavos del papel", () => {
  assert.equal(clean(formatMoneyCents(2291.63)), clean(new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(2291.63)));
  assert.match(formatMoneyCents(2291.63), /2\.291,63/);
});

it("sin centavos se ve igual que siempre", () => {
  assert.match(formatMoneyCents(42000), /42\.000$/);
  assert.doesNotMatch(formatMoneyCents(42000), /,/);
});
