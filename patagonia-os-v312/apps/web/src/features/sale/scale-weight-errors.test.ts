import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { forgetWeightScale, readScaleWeight } from "./scale-weight";
import { FakeWeightPort } from "./test-fake-serial";

function pairedPorts(ports: FakeWeightPort[]) {
  Object.defineProperty(globalThis, "navigator", {
    value: { serial: { getPorts: async () => ports } },
    configurable: true
  });
}

afterEach(async () => {
  await forgetWeightScale();
});

describe("scale-weight (Mostrador) — una sola balanza", () => {
  it("lee peso, precio e importe aunque lleguen en dos pedazos", async () => {
    pairedPorts([new FakeWeightPort([[5, "2,01.250,\r"], [40, ",0100.00,\r,00125.00,\r"]])]);
    const { frame } = await readScaleWeight();
    assert.deepEqual(frame, { weightKg: 1.25, price: 100, amount: 125 });
  });

  it("si no contesta, avisa en vez de inventar un peso", async () => {
    pairedPorts([new FakeWeightPort()]);
    await assert.rejects(readScaleWeight(), /La balanza no respondió/);
  });

  it("si contesta algo que no es un peso, avisa qué recibió", async () => {
    pairedPorts([new FakeWeightPort([[5, "hola"]])]);
    await assert.rejects(readScaleWeight(), /Recibí datos de la balanza pero no pude leer el peso/);
  });
});
