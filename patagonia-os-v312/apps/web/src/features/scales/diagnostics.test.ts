import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runScaleDiagnostics } from "./diagnostics";
import type { ScaleDriver } from "./types";

const FAKE_PORT = {} as SerialPort;

function baseDriver(overrides: Partial<ScaleDriver>): ScaleDriver {
  return {
    id: "fake",
    brand: "Fake",
    models: ["Fake 1"],
    status: "certified",
    capabilities: [],
    identify: async () => ({ matched: true }),
    ...overrides
  };
}

describe("runScaleDiagnostics", () => {
  it("balanza de peso: ping + lectura ok da diagnóstico completo en verde", async () => {
    const driver = baseDriver({
      capabilities: ["ping", "readWeight"],
      ping: async () => ({ ok: true, message: "Responde" }),
      readWeight: async () => ({ weightKg: 1.25, raw: "raw" })
    });
    const report = await runScaleDiagnostics(driver, FAKE_PORT, {});
    assert.equal(report.overallOk, true);
    assert.equal(report.steps.length, 2);
    assert.ok(report.steps.every((s) => s.ok));
  });

  it("si falla la conexión, no sigue probando el resto", async () => {
    let readWeightCalled = false;
    const driver = baseDriver({
      capabilities: ["ping", "readWeight"],
      ping: async () => ({ ok: false, message: "Sin respuesta" }),
      readWeight: async () => {
        readWeightCalled = true;
        return { weightKg: 1, raw: "" };
      }
    });
    const report = await runScaleDiagnostics(driver, FAKE_PORT, {});
    assert.equal(report.overallOk, false);
    assert.equal(report.steps.length, 1);
    assert.equal(readWeightCalled, false);
  });

  it("sin capacidad de ping, usa identify() como chequeo de conectividad", async () => {
    let identifyCalled = false;
    const driver = baseDriver({
      capabilities: ["readPlu", "writePlu"],
      identify: async () => {
        identifyCalled = true;
        return { matched: true };
      },
      runCertificationTest: async () => ({ passed: true, message: "Compatible" })
    });
    const report = await runScaleDiagnostics(driver, FAKE_PORT, {});
    assert.equal(identifyCalled, true);
    assert.equal(report.overallOk, true);
    assert.equal(report.steps[1].label, "Envío y lectura de productos");
  });

  it("una lectura de peso que tira error queda como paso fallido, no como excepción", async () => {
    const driver = baseDriver({
      capabilities: ["ping", "readWeight"],
      ping: async () => ({ ok: true }),
      readWeight: async () => {
        throw new Error("La balanza no respondió.");
      }
    });
    const report = await runScaleDiagnostics(driver, FAKE_PORT, {});
    assert.equal(report.overallOk, false);
    assert.equal(report.steps[1].ok, false);
    assert.match(report.steps[1].detail, /no respondió/);
  });
});
