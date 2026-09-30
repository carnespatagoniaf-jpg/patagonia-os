import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeWeightPort } from "../../sale/test-fake-serial";
import { kretzAuraWeightDriver as driver } from "./kretz-aura-weight";

const asPort = (p: FakeWeightPort) => p as unknown as SerialPort;

describe("driver Kretz Aura (peso)", () => {
  it("reconoce una Aura que contesta el peso", async () => {
    const result = await driver.identify!(asPort(new FakeWeightPort([[5, "2,01.250,\r"]])));
    assert.equal(result.matched, true);
    assert.equal(result.displayName, "Kretz Aura Eco");
  });

  it("no reconoce un aparato que no contesta", async () => {
    const result = await driver.identify!(asPort(new FakeWeightPort()));
    assert.equal(result.matched, false);
  });

  it("lee peso, precio e importe aunque lleguen en dos pedazos", async () => {
    const port = new FakeWeightPort([[5, "2,01.250,\r"], [40, ",0100.00,\r,00125.00,\r"]]);
    const reading = await driver.readWeight!(asPort(port), {});
    assert.equal(reading.weightKg, 1.25);
    assert.equal(reading.price, 100);
    assert.equal(reading.amount, 125);
  });

  it("si no contesta, avisa en vez de inventar un peso", async () => {
    await assert.rejects(driver.readWeight!(asPort(new FakeWeightPort()), {}), /La balanza no respondió/);
  });

  it("si contesta algo que no es un peso, avisa qué recibió", async () => {
    await assert.rejects(driver.readWeight!(asPort(new FakeWeightPort([[5, "hola"]])), {}), /Recibí datos de la balanza pero no pude leer el peso/);
  });
});
