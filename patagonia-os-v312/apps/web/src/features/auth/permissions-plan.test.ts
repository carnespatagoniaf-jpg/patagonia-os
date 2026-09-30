import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserProfile } from "./AuthProvider";
import { can, canAccessPage, planAllows, profilePlan, type Plan } from "./permissions";

function owner(plan?: Plan | string): UserProfile {
  return { id: "u", company_id: "c", branch_id: "b", full_name: "Dueño", role: "owner", active: true, plan: plan as Plan };
}

describe("planes: qué ve cada uno", () => {
  it("Básico no ve lo de Estándar ni lo de Full", () => {
    const p = owner("basico");
    for (const page of ["customers", "employees", "carcass", "recipes", "profitability", "creditors", "scales", "branches"] as const) {
      assert.equal(canAccessPage(p, page), false, page);
    }
  });

  it("Básico sí ve lo de todos los planes", () => {
    const p = owner("basico");
    for (const page of ["dashboard", "sale", "products", "inventory", "purchases", "treasury", "reports", "export", "import", "users"] as const) {
      assert.equal(canAccessPage(p, page), true, page);
    }
  });

  it("Estándar ve Clientes, Despiece, Recetas, Balanzas… pero no la pantalla Sucursales", () => {
    const p = owner("estandar");
    for (const page of ["customers", "employees", "carcass", "recipes", "profitability", "creditors", "scales"] as const) {
      assert.equal(canAccessPage(p, page), true, page);
    }
    assert.equal(canAccessPage(p, "branches"), false);
  });

  it("Estándar puede cambiar de sucursal (el selector usa branches.manage)", () => {
    assert.equal(can(owner("estandar"), "branches.manage"), true);
    assert.equal(can(owner("basico"), "branches.manage"), true);
  });

  it("Full ve todo", () => {
    const p = owner("full");
    for (const page of ["customers", "recipes", "scales", "branches"] as const) {
      assert.equal(canAccessPage(p, page), true, page);
    }
  });

  it("sin dato de plan (modo demo o base sin migrar) cuenta como Full", () => {
    assert.equal(profilePlan(owner(undefined)), "full");
    assert.equal(profilePlan(owner("raro")), "full");
    assert.equal(canAccessPage(owner(undefined), "branches"), true);
  });

  it("el plan nunca le da a un rol algo que su rol no tiene", () => {
    const cashier: UserProfile = { ...owner("full"), role: "cashier" };
    assert.equal(canAccessPage(cashier, "customers"), false);
    assert.equal(planAllows(cashier, "full"), true);
  });
});
