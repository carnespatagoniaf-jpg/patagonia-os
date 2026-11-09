import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVariants, variantProducts } from "./product-variants";

test("lee variantes con y sin stock, por coma o renglón", () => {
  const r = parseVariants("Negro: 3, Marrón\nVerde agua: 1 ;");
  assert.equal(r.error, null);
  assert.deepEqual(r.variants, [
    { label: "Negro", stock: 3 },
    { label: "Marrón", stock: null },
    { label: "Verde agua", stock: 1 }
  ]);
});

test("avisa lo que no se entiende", () => {
  assert.match(parseVariants("Negro: tres, Marrón").error ?? "", /no es un número/);
  assert.match(parseVariants("Negro, negro").error ?? "", /dos veces/);
  assert.match(parseVariants("Negro").error ?? "", /una sola/);
  assert.match(parseVariants("Negro: 1: 2, Rojo").error ?? "", /No se entiende/);
  assert.deepEqual(parseVariants("   ").variants, []);
});

test("arma código y nombre de cada variante", () => {
  const { variants } = parseVariants("Negro: 2, Marrón");
  assert.deepEqual(variantProducts(" 120 ", " Mate imperial ", variants), [
    { code: "120-1", name: "Mate imperial - Negro", stock: 2 },
    { code: "120-2", name: "Mate imperial - Marrón", stock: null }
  ]);
});
