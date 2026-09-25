import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bytesToText, describeRawFrame, parseScaleFrame } from "./scale-weight-parser";

const CR = "\r";

describe("parseScaleFrame — solo peso", () => {
  it("lee el mensaje con comas literales: 2,01.250,CR", () => {
    assert.deepEqual(parseScaleFrame(`2,01.250,${CR}`), { weightKg: 1.25 });
  });

  it("lee el mensaje sin comas y con el 2 pegado: 201.250CR", () => {
    assert.deepEqual(parseScaleFrame(`201.250${CR}`), { weightKg: 1.25 });
    assert.deepEqual(parseScaleFrame(`212.250${CR}`), { weightKg: 12.25 });
  });

  it("lee con el inicio como carácter de control (STX) y peso con espacio de relleno", () => {
    assert.deepEqual(parseScaleFrame(`\u0002 1.250${CR}`), { weightKg: 1.25 });
    assert.deepEqual(parseScaleFrame(`\u000201.250${CR}`), { weightKg: 1.25 });
  });

  it("lee el peso solo, sin inicio", () => {
    assert.deepEqual(parseScaleFrame(`12.345${CR}`), { weightKg: 12.345 });
  });

  it("toma el primer mensaje si llegaron varios (modo continuo)", () => {
    assert.deepEqual(parseScaleFrame(`2,00.500,${CR}2,00.500,${CR}`), { weightKg: 0.5 });
  });
});

describe("parseScaleFrame — peso, precio e importe", () => {
  it("lee los tres valores", () => {
    const text = `2,01.250,${CR},0100.00,${CR},00125.00,${CR}`;
    assert.deepEqual(parseScaleFrame(text), { weightKg: 1.25, price: 100, amount: 125 });
  });

  it("lee los tres valores sin comas", () => {
    const text = `201.250${CR}0100.00${CR}00125.00${CR}`;
    assert.deepEqual(parseScaleFrame(text), { weightKg: 1.25, price: 100, amount: 125 });
  });
});

describe("parseScaleFrame — rechazos", () => {
  it("rechaza mensajes cortados (sin CR), vacíos, ruido y pesos imposibles", () => {
    assert.equal(parseScaleFrame("2,01.250"), null);
    assert.equal(parseScaleFrame(""), null);
    assert.equal(parseScaleFrame(`hola${CR}`), null);
    assert.equal(parseScaleFrame(`2,00.000,${CR}`), null);
    assert.equal(parseScaleFrame(`abc.def${CR}`), null);
  });
});

describe("utilidades de texto", () => {
  it("convierte bytes a texto y muestra los caracteres de control", () => {
    const text = bytesToText([2, 48, 49, 46, 50, 53, 48, 13]);
    assert.equal(text, "\u000201.250\r");
    assert.equal(describeRawFrame(text), "<2>01.250⏎");
  });
});
