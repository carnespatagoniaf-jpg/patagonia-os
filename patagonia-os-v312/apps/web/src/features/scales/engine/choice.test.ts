import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installFakeLocalStorage } from "../test-fake-storage";
import { choiceFromRemembered, loadScaleChoice, saveScaleChoice, searchPlan } from "./choice";
import type { RememberedScale } from "./memory";

const rem = (model: RememberedScale["model"], family: RememberedScale["family"]): RememberedScale => ({ model, label: "x", family, usb: null, connectedAt: "", syncedAt: null });

describe("¿Qué balanza tenés?", () => {
  beforeEach(() => installFakeLocalStorage());

  it("cada elección conecta SOLO con esa balanza (en segundos, sin probar las demás)", () => {
    assert.deepEqual(searchPlan("kretz-report"), { families: ["kretz"], kretzOnly: "report-lt" });
    assert.deepEqual(searchPlan("kretz-aura"), { families: ["kretz"], kretzOnly: "aura" });
    assert.deepEqual(searchPlan("systel"), { families: ["systel"], kretzOnly: null });
  });

  it("\"No sé\" busca en todas las marcas, como antes", () => {
    assert.deepEqual(searchPlan("auto"), { families: ["kretz", "systel"], kretzOnly: null });
  });

  it("los clientes que ya conectaron no tienen que elegir: se toma la balanza que ya anduvo en esa PC", () => {
    assert.equal(choiceFromRemembered(rem("kretz-aura", "kretz")), "kretz-aura"); // Pollo y mar
    assert.equal(choiceFromRemembered(rem("systel-cuora-max", "systel")), "systel"); // Los gringos
    assert.equal(choiceFromRemembered(rem("kretz-report-lt", "kretz")), "kretz-report");
    assert.equal(choiceFromRemembered(rem("kretz-otra", "kretz")), null);
    assert.equal(loadScaleChoice(rem("kretz-aura", "kretz")), "kretz-aura");
    assert.equal(loadScaleChoice(null), null);
  });

  it("lo elegido se recuerda en la PC y \"Es otra balanza\" lo borra", () => {
    saveScaleChoice("kretz-report");
    assert.equal(loadScaleChoice(rem("kretz-aura", "kretz")), "kretz-report");
    saveScaleChoice(null);
    assert.equal(loadScaleChoice(null), null);
  });
});
