import { test } from "node:test";
import assert from "node:assert/strict";
import { consumerLegendLines, needsPbaConsumerLegend } from "./consumer-legend";

test("Provincia de Buenos Aires lleva la leyenda con la Línea 148", () => {
  assert.equal(needsPbaConsumerLegend("Buenos Aires"), true);
  assert.equal(needsPbaConsumerLegend("buenos aires "), true);
  assert.deepEqual(consumerLegendLines("Buenos Aires"), ["Orientación al Consumidor", "Provincia de Buenos Aires: 148", "Línea gratuita"]);
});

test("CABA, otras provincias o sin provincia no la llevan", () => {
  assert.equal(needsPbaConsumerLegend("CABA"), false);
  assert.equal(needsPbaConsumerLegend("Córdoba"), false);
  assert.equal(needsPbaConsumerLegend(null), false);
  assert.deepEqual(consumerLegendLines(null), []);
});
