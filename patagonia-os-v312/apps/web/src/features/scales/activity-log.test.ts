import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installFakeLocalStorage } from "./test-fake-storage";

installFakeLocalStorage();

const { clearActivityLog, exportActivityLogText, getActivityLog, logScaleActivity } = await import("./activity-log");

describe("activity-log", () => {
  it("registra en orden y arma un texto plano para copiar", () => {
    clearActivityLog();
    logScaleActivity({ kind: "detect", message: "Detectada Kretz Aura Eco." });
    logScaleActivity({ kind: "sync", connectionLabel: "Kretz Report", message: "12/12 confirmados." });

    const log = getActivityLog();
    assert.equal(log.length, 2);
    assert.equal(log[0].kind, "detect");
    assert.equal(log[1].connectionLabel, "Kretz Report");

    const text = exportActivityLogText();
    assert.match(text, /DETECT: Detectada Kretz Aura Eco\./);
    assert.match(text, /SYNC \(Kretz Report\): 12\/12 confirmados\./);
  });

  it("sin actividad, el texto lo dice explícitamente", () => {
    clearActivityLog();
    assert.equal(exportActivityLogText(), "Sin actividad registrada todavía.");
  });

  it("no crece sin límite -- recorta a las últimas entradas", () => {
    clearActivityLog();
    for (let i = 0; i < 250; i++) logScaleActivity({ kind: "test", message: `evento ${i}` });
    const log = getActivityLog();
    assert.ok(log.length <= 200);
    assert.equal(log[log.length - 1].message, "evento 249");
  });
});
