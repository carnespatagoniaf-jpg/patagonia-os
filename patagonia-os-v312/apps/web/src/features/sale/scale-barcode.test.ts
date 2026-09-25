import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectScaleConfig, parseTicketTotalBarcode, parseWeightBarcode } from "./scale-barcode";

/** Dígito verificador EAN-13 para los primeros 12 dígitos. */
function withCheckDigit(first12: string): string {
  const sum = first12.split("").reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + String((10 - (sum % 10)) % 10);
}

describe("parseTicketTotalBarcode (ticket de total de la balanza Kretz Aura)", () => {
  it("lee el ticket real de 13 dígitos: $14.550", () => {
    assert.equal(parseTicketTotalBarcode("0000014550003"), 14550);
  });

  it("lee el mismo ticket cuando el lector omite el primer cero (12 dígitos)", () => {
    assert.equal(parseTicketTotalBarcode("000014550003"), 14550);
  });

  it("rechaza un dígito verificador incorrecto", () => {
    assert.equal(parseTicketTotalBarcode("0000014550004"), null);
    assert.equal(parseTicketTotalBarcode("000014550004"), null);
  });

  it("no confunde una etiqueta de un solo producto con un ticket de total", () => {
    assert.equal(parseTicketTotalBarcode(withCheckDigit("200012012500")), null);
  });

  it("rechaza importe cero, largos raros y texto", () => {
    assert.equal(parseTicketTotalBarcode("0000000000000"), null);
    assert.equal(parseTicketTotalBarcode("00000145500"), null);
    assert.equal(parseTicketTotalBarcode("00000145500030"), null);
    assert.equal(parseTicketTotalBarcode("abc"), null);
    assert.equal(parseTicketTotalBarcode(""), null);
  });

  it("lee otros importes con centavos, hasta $99.999,99", () => {
    assert.equal(parseTicketTotalBarcode(withCheckDigit("000000123450")), 1234.5);
    assert.equal(parseTicketTotalBarcode(withCheckDigit("000009999999")), 99999.99);
  });

  it("límite conocido: el formato confirmado tiene 5 ceros + 7 dígitos, así que $100.000 o más no se lee", () => {
    assert.equal(parseTicketTotalBarcode(withCheckDigit("000010000000")), null);
  });
});

describe("parseWeightBarcode (etiqueta de un producto, formato Kretz por defecto)", () => {
  it("lee PLU y peso en kg", () => {
    const code = withCheckDigit("200012012500"); // prefijo 2, PLU 00012, 01250 g
    assert.deepEqual(parseWeightBarcode(code), { plu: "12", kind: "weight", weightKg: 1.25 });
  });

  it("rechaza largos incorrectos y peso cero", () => {
    assert.equal(parseWeightBarcode("12345"), null);
    assert.equal(parseWeightBarcode(withCheckDigit("200012000000")), null);
  });

  it("no acepta letras", () => {
    assert.equal(parseWeightBarcode("20001201250A3"), null);
  });
});

describe("detectScaleConfig (asistente de calibración)", () => {
  it("encuentra la configuración que reproduce el peso indicado", () => {
    // prefijo de 2 dígitos + PLU 5 + peso 5 (gramos) + verificador = 13
    const code = withCheckDigit("200001201250");
    const config = detectScaleConfig(code, 1.25);
    assert.ok(config);
    assert.deepEqual(parseWeightBarcode(code, config), { plu: "12", kind: "weight", weightKg: 1.25 });
  });

  it("devuelve null si el peso indicado no coincide con nada", () => {
    assert.equal(detectScaleConfig(withCheckDigit("200012012500"), 99.9), null);
  });
});
