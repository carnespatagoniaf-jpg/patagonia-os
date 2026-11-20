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

  it("Estándar ve Clientes, Despiece, Recetas, Balanzas y Sucursales (solo Precios por zona, migración 197)", () => {
    const p = owner("estandar");
    for (const page of ["customers", "employees", "carcass", "recipes", "profitability", "creditors", "scales", "branches"] as const) {
      assert.equal(canAccessPage(p, page), true, page);
    }
    assert.equal(planAllows(p, "full"), false, "el tablero de Sucursales sigue siendo de Full");
    assert.equal(canAccessPage(p, "reconciliation"), false, "Conciliación es de Full");
  });

  it("Estándar puede cambiar de sucursal (el selector usa branches.manage)", () => {
    assert.equal(can(owner("estandar"), "branches.manage"), true);
    assert.equal(can(owner("basico"), "branches.manage"), true);
  });

  it("Full ve todo", () => {
    const p = owner("full");
    for (const page of ["customers", "recipes", "scales", "branches", "reconciliation"] as const) {
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

describe("pantallas que una empresa no usa (companies.features 'no:<permiso>')", () => {
  it("se le sacan a todos sus usuarios, incluido el dueño, y nada más", () => {
    const features = ["venta_ruta", "no:carcass.manage", "no:recipes.manage"];
    const admin: UserProfile = { ...owner("estandar"), role: "admin", features };
    const ownerUser: UserProfile = { ...owner("estandar"), features };
    for (const p of [admin, ownerUser]) {
      assert.equal(canAccessPage(p, "carcass"), false);
      assert.equal(canAccessPage(p, "recipes"), false);
      assert.equal(canAccessPage(p, "customers"), true);
      assert.equal(canAccessPage(p, "route"), true);
    }
  });
});

describe("Clientes sin cobrar (customers.payments, 2026-11-17)", () => {
  function admin(denied: string[] = []): UserProfile {
    return { id: "u", company_id: "c", branch_id: "b", full_name: "Cajera", role: "admin", active: true, plan: "full", denied_permissions: denied };
  }
  it("un administrador registra pagos por defecto", () => {
    assert.equal(can(admin(), "customers.payments"), true);
  });
  it("destildado: sigue viendo Clientes pero no registra pagos", () => {
    const p = admin(["customers.payments"]);
    assert.equal(canAccessPage(p, "customers"), true);
    assert.equal(can(p, "customers.payments"), false);
  });
  it("Básico no tiene Clientes ni sus pagos", () => {
    assert.equal(can(owner("basico"), "customers.payments"), false);
  });
});

describe("pantalla suelta escondida (no:page:<página>, 2026-11-20)", () => {
  it("Fabrica: sin Exportar pero con Reportes", () => {
    const p: UserProfile = { ...owner("estandar"), role: "admin", features: ["no:page:export"] };
    assert.equal(canAccessPage(p, "export"), false);
    assert.equal(canAccessPage(p, "reports"), true);
    assert.equal(canAccessPage(p, "profitability"), true);
  });
});
