import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeWeightPort } from "./test-fake-serial";

// `navigator.serial` tiene que existir ANTES de cargar el módulo.
let paired: FakeWeightPort[] = [];
const serial = Object.assign(new EventTarget(), { getPorts: async () => paired });
Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("scale-weight — suelta el puerto cuando no lo usa", () => {
  it("después de leer el peso, el puerto se cierra solo y la próxima lectura lo vuelve a abrir", async () => {
    const { readScaleWeight, setWeightIdleCloseMs } = await import("./scale-weight");
    setWeightIdleCloseMs(40);
    const port = new FakeWeightPort([[2, "2,01.500,\r"]]);
    paired = [port];
    assert.equal((await readScaleWeight()).frame.weightKg, 1.5);
    assert.ok(port.readable, "recién leído: sigue abierto");
    await wait(80);
    assert.equal(port.readable, null, "sin uso: se cerró (otra pestaña o programa ya puede abrirlo)");
    assert.equal((await readScaleWeight()).frame.weightKg, 1.5);
    assert.equal(port.opens, 2);
    await wait(80);
    assert.equal(port.readable, null);
  });

  it("si la lectura falla, igual suelta el puerto", async () => {
    const { readScaleWeight, setWeightIdleCloseMs, forgetWeightScale } = await import("./scale-weight");
    await forgetWeightScale();
    setWeightIdleCloseMs(40);
    const mute = new FakeWeightPort([]);
    paired = [mute];
    await assert.rejects(readScaleWeight());
    await wait(80);
    assert.equal(mute.readable, null);
  });
});
