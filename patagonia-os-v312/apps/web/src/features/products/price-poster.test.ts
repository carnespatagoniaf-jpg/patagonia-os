import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPosterHtml, businessSizeMm, defaultDetail, formatPosterPrice, nameSizeMm, priceSizeMm } from "./price-poster";

test("precio como en el cartel real", () => {
  assert.equal(formatPosterPrice(14400), "$14.400");
  assert.equal(formatPosterPrice(4900), "$4.900");
  assert.equal(formatPosterPrice(1234567), "$1.234.567");
  assert.equal(formatPosterPrice(1234.5), "$1.234,50");
  assert.equal(formatPosterPrice(0), "$0");
});

test("tamaños: nombre, precio y local largos se achican", () => {
  assert.equal(nameSizeMm("CUADRIL"), 15);
  assert.equal(nameSizeMm("BIFE DE CHORIZO"), 12);
  assert.equal(nameSizeMm("BOLA DE LOMO DE CERDO"), 10);
  assert.equal(priceSizeMm("$14.400"), 40);
  assert.equal(priceSizeMm("$140.000"), 34);
  assert.equal(priceSizeMm("$1.400.000"), 28);
  assert.equal(businessSizeMm("CARNES PATAGONIA"), 12);
  assert.equal(businessSizeMm("CARNICERIA LOS GRINGOS"), 9);
  assert.equal(defaultDetail("kg"), "el kilo");
  assert.equal(defaultDetail("unit"), "la unidad");
});

test("una hoja A4: local arriba, nombre, precio y 'el kilo'; mitad de abajo libre", () => {
  const html = buildPosterHtml({ business: "Carnes Patagonia", name: "Cuadril", price: 21700, detail: "el kilo" });
  assert.equal((html.match(/class="page"/g) ?? []).length, 1);
  assert.match(html, /class="top"[^>]*>CARNES PATAGONIA</);
  assert.match(html, />CUADRIL</);
  assert.match(html, />\$21\.700</);
  assert.match(html, />el kilo</);
  assert.match(html, /class="c blank"/);
  assert.match(html, /@page\{size:A4;margin:0\}/);
});

test("sin nombre de local no hay franja; el texto se escapa", () => {
  const html = buildPosterHtml({ business: "", name: "<b>x</b>", price: 100, detail: "a & b" });
  assert.ok(!html.includes('class="top"'));
  assert.ok(!html.includes("<b>x</b>"));
  assert.match(html, /a &amp; b/);
});
