import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installSteps, installSummary, localInstall, markLabelReadLocally, newestInstall, saveLocalInstall } from "./install-status";
import { installFakeLocalStorage } from "./test-fake-storage";

const now = new Date("2026-10-28T15:00:00");

describe("los 5 estados reales de una instalación (etapa 0)", () => {
  beforeEach(() => installFakeLocalStorage());

  it("nunca 'lista para vender' sin una etiqueta leída en Mostrador después del último envío", () => {
    const r = { model: "Kretz Report", detectedAt: "2026-10-28T14:00:00", communicationAt: "2026-10-28T14:00:00", sentAt: "2026-10-28T14:05:00", sentCount: 20, verifiedAt: "2026-10-28T14:05:00", verifiedCount: 20, failedCount: 0 };
    assert.deepEqual(installSteps(r, now).map((s) => s.done), [true, true, true, true, false]);
    assert.match(installSummary(r, now).text, /4 de 5 pasos · falta: etiqueta probada/);
    // Etiqueta leída ANTES del último envío: no cuenta.
    const old = { ...r, saleTestedAt: "2026-10-28T13:00:00" };
    assert.equal(installSteps(old, now)[4].done, false);
    assert.match(installSteps(old, now)[4].detail, /después del último envío/);
    const ok = { ...r, saleTestedAt: "2026-10-28T14:10:00", saleTestDetail: "Vacio: 1,250 kg" };
    assert.equal(installSteps(ok, now).every((s) => s.done), true);
    assert.match(installSummary(ok, now).text, /^Lista para vender/);
  });

  it("si algún producto no quedó bien, no está comprobado ni probado", () => {
    const r = { detectedAt: "x", communicationAt: "2026-10-28T14:00:00", sentAt: "2026-10-28T14:05:00", verifiedAt: "2026-10-28T14:05:00", failedCount: 2, saleTestedAt: "2026-10-28T14:10:00" };
    assert.deepEqual(installSteps(r, now).map((s) => s.done), [true, true, true, false, false]);
    assert.match(installSteps(r, now)[3].detail, /2 no quedaron bien/);
  });

  it("un error nuevo se muestra antes que lo viejo comprobado", () => {
    const r = { detectedAt: "2026-10-27T10:00:00", communicationAt: "2026-10-27T10:00:00", lastError: "no contestó", lastErrorAt: "2026-10-28T14:00:00" };
    assert.equal(installSummary(r, now).tone, "bad");
  });

  it("en esta computadora + la etiqueta leída en Mostrador; y mezcla con la ficha central por fecha", () => {
    saveLocalInstall("b1", "kretz-1", { detectedAt: "2026-10-28T14:00:00", verifiedAt: "2026-10-28T14:05:00", failedCount: 0 });
    markLabelReadLocally("b1", "Vacio: 1,250 kg", new Date("2026-10-28T14:20:00"));
    const local = localInstall("b1", "kretz-1")!;
    assert.equal(local.saleTestDetail, "Vacio: 1,250 kg");
    const central = { detectedAt: "2026-10-28T09:00:00", verifiedAt: "2026-10-28T16:00:00", verifiedCount: 30, failedCount: 0 };
    const m = newestInstall(local, central);
    assert.equal(m.detectedAt, "2026-10-28T14:00:00");
    assert.equal(m.verifiedCount, 30);
    assert.equal(m.saleTestDetail, "Vacio: 1,250 kg");
  });
});
