import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyInvoiceDraft, formatCuit, invoiceDraftError, invoiceLabel, invoiceLetterFor, isValidCuit } from "./invoicing-view";

test("CUIT: dígito verificador", () => {
  assert.equal(isValidCuit("27182448902"), true);
  assert.equal(isValidCuit("27-18244890-2"), true);
  assert.equal(isValidCuit("20-12345678-6"), true);
  assert.equal(isValidCuit("27182448903"), false);
  assert.equal(isValidCuit("2718244890"), false);
  assert.equal(formatCuit("27182448902"), "27-18244890-2");
});

test("qué letra sale", () => {
  assert.equal(invoiceLetterFor("monotributo", "responsable_inscripto"), "C");
  assert.equal(invoiceLetterFor("monotributo", "consumidor_final"), "C");
  assert.equal(invoiceLetterFor("responsable_inscripto", "responsable_inscripto"), "A");
  assert.equal(invoiceLetterFor("responsable_inscripto", "monotributo"), "A");
  assert.equal(invoiceLetterFor("responsable_inscripto", "consumidor_final"), "B");
  assert.equal(invoiceLetterFor("responsable_inscripto", "exento"), "B");
});

test("validaciones antes de cobrar (las mismas que la base)", () => {
  const base = { ...emptyInvoiceDraft(), wanted: true };
  assert.equal(invoiceDraftError("responsable_inscripto", { ...base, wanted: false, doc: "1" }, 1000), null, "sin factura no valida nada");
  assert.equal(invoiceDraftError("responsable_inscripto", base, 24656), null, "B a consumidor final sin datos");
  assert.match(invoiceDraftError("responsable_inscripto", { ...base, customerCondition: "responsable_inscripto" }, 1000)!, /CUIT/);
  assert.equal(invoiceDraftError("responsable_inscripto", { ...base, customerCondition: "responsable_inscripto", doc: "20-12345678-6" }, 1000), null);
  assert.match(invoiceDraftError("responsable_inscripto", { ...base, doc: "20123456789" }, 1000)!, /no es válido/);
  assert.match(invoiceDraftError("monotributo", { ...base, doc: "123" }, 1000)!, /CUIT \(11 números\) o un DNI/);
  assert.equal(invoiceDraftError("monotributo", { ...base, doc: "30.123.456" }, 1000), null, "DNI con puntos");
  assert.match(invoiceDraftError("monotributo", base, 10_000_000)!, /10\.000\.000/);
});

test("cómo se muestra el número", () => {
  assert.equal(invoiceLabel({ kind: "factura", letter: "B", pointOfSale: 5, number: 123 }), "Factura B 00005-00000123");
  assert.equal(invoiceLabel({ kind: "nota_credito", letter: "C", pointOfSale: 12, number: 7 }), "Nota de crédito C 00012-00000007");
  assert.equal(invoiceLabel({ kind: "factura", letter: "A", pointOfSale: 5, number: null }), "Factura A (sin número todavía)");
});
