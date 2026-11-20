import { test } from "node:test";
import assert from "node:assert/strict";
import { compareValues, matchesSearch, nextSort, normalizeText, sortRows } from "./table-logic";

test("buscar ignora acentos, mayúsculas y orden de las palabras", () => {
  assert.equal(normalizeText("  Río GALLEGOS "), "rio gallegos");
  assert.ok(matchesSearch("Carnes Patagonia · Río Gallegos · Santa Cruz", "gallegos rio"));
  assert.ok(matchesSearch("cualquier cosa", "   "));
  assert.ok(!matchesSearch("Carnes Patagonia", "pollo"));
});

test("ordenar: números como números, textos en español, vacíos al final", () => {
  assert.ok(compareValues(9, 10, "asc") < 0);
  assert.ok(compareValues("Cliente 9", "Cliente 10", "asc") < 0);
  assert.ok(compareValues("ñandú", "zorro", "asc") < 0);
  assert.equal(compareValues(null, 3, "asc"), 1);
  assert.equal(compareValues(null, 3, "desc"), 1);
  const rows = [{ n: "b", v: 2 }, { n: "a", v: null }, { n: "c", v: 1 }, { n: "d", v: 2 }];
  assert.deepEqual(sortRows(rows, (r) => r.v, "desc").map((r) => r.n), ["b", "d", "c", "a"]);
  assert.deepEqual(rows.map((r) => r.n), ["b", "a", "c", "d"], "no cambia el original");
});

test("tocar el encabezado: asc → desc → sin orden", () => {
  let s = nextSort(null, "name");
  assert.deepEqual(s, { key: "name", dir: "asc" });
  s = nextSort(s, "name");
  assert.deepEqual(s, { key: "name", dir: "desc" });
  assert.equal(nextSort(s, "name"), null);
  assert.deepEqual(nextSort(s, "debt", "desc"), { key: "debt", dir: "desc" });
});
