import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserProfile } from "./AuthProvider";
import { can } from "./permissions";

/** scales.send (migración 224, decisión del dueño 27/11/2026): "solo lectura no modifica ni envía productos a las balanzas". */
function user(role: UserProfile["role"], extra: Partial<UserProfile> = {}): UserProfile {
  return { id: "u", company_id: "c", branch_id: "b", full_name: "X", role, active: true, plan: "estandar", ...extra };
}

describe("scales.send: quién manda productos a la balanza", () => {
  it("dueño, administrador, encargado, producción y cajero sí", () => {
    for (const role of ["owner", "admin", "manager", "production", "cashier"] as const) assert.equal(can(user(role), "scales.send"), true, role);
  });

  it("solo lectura y contador no", () => {
    assert.equal(can(user("readonly"), "scales.send"), false);
    assert.equal(can(user("accountant"), "scales.send"), false);
  });

  it("destildado en Usuarios (denied_permissions) se lo saca", () => {
    assert.equal(can(user("cashier", { denied_permissions: ["scales.send"] }), "scales.send"), false);
  });

  it("va en todos los planes (la calibración de Mostrador es de Básico también)", () => {
    assert.equal(can(user("cashier", { plan: "basico" }), "scales.send"), true);
  });

  it("un negocio que no es carnicería no lo tiene", () => {
    assert.equal(can(user("owner", { features: ["sin_carniceria"] }), "scales.send"), false);
  });
});
