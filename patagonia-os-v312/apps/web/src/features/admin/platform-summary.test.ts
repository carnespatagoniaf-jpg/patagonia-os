import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dueSoonList, monthChangePct, pageLabel, upgradeCandidates } from "./platform-summary";

const TODAY = "2026-10-18";

describe("resumen de plataforma", () => {
  it("variación mensual", () => {
    assert.equal(monthChangePct(612000, 537000), 14);
    assert.equal(monthChangePct(100, 0), null);
  });

  it("nombre de pantalla", () => {
    assert.equal(pageLabel("sale"), "Mostrador");
    assert.equal(pageLabel("nueva"), "nueva");
  });

  it("candidatos a subir de plan", () => {
    const limits = { basico: { maxBranches: 1, maxUsers: 2 }, estandar: { maxBranches: 2, maxUsers: 8 }, full: { maxBranches: null, maxUsers: null } };
    const plans = {
      a: { plan: "basico" as const, activeBranches: 1, activeUsers: 2 },
      b: { plan: "estandar" as const, activeBranches: 2, activeUsers: 3 },
      d: { plan: "basico" as const, activeBranches: 1, activeUsers: 1 },
      c: { plan: "full" as const, activeBranches: 9, activeUsers: 30 }
    };
    assert.deepEqual(upgradeCandidates(["a", "b", "c", "d", "x"], plans, limits), [
      { companyId: "a", reason: "usa 2 de 2 usuarios" },
      { companyId: "b", reason: "usa 2 de 2 sucursales" }
    ]);
  });

  it("vencen esta semana", () => {
    const base = { name: "", trialEndsAt: null, active: true };
    const list = [
      { ...base, id: "a", paidUntil: "2026-10-20" },
      { ...base, id: "b", paidUntil: "2026-10-18" },
      { ...base, id: "c", paidUntil: "2026-10-30" },
      { ...base, id: "d", paidUntil: "2026-10-10" },
      { ...base, id: "e", paidUntil: "2026-10-19" }
    ];
    assert.deepEqual(dueSoonList(list, TODAY, (c) => c.id === "e").map((x) => [x.company.id, x.days]), [["b", 0], ["a", 2]]);
  });
});
