import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserProfile } from "../features/auth/AuthProvider";
import { canAccessPage } from "../features/auth/permissions";
import { navGroups, visibleItem } from "./nav";

const profile = (role: UserProfile["role"], plan: UserProfile["plan"] = "full", features: string[] = []): UserProfile =>
  ({ id: "u", company_id: "c", branch_id: "b", full_name: "X", role, active: true, plan, features }) as UserProfile;

function menu(p: UserProfile) {
  return navGroups
    .map((g) => ({ heading: g.heading, items: g.items.map((i) => visibleItem(i, (page) => canAccessPage(p, page))).filter((i) => i !== null) }))
    .filter((g) => g.items.length > 0);
}
const labels = (p: UserProfile) => menu(p).flatMap((g) => g.items.map((i) => i!.label));
const item = (p: UserProfile, label: string) => menu(p).flatMap((g) => g.items).find((i) => i!.label === label);

describe("Menú más simple (aprobado por el dueño 30/10)", () => {
  it("cliente normal (administrador, Full): 16 botones con los grupos de siempre (antes 21)", () => {
    const admin = profile("admin");
    assert.deepEqual(labels(admin), ["Inicio", "Mostrador", "Clientes", "Productos", "Stock", "Compras", "Despiece", "Tesorería", "Bancos", "Contable", "Deudas", "Sucursales", "Empleados", "Usuarios", "Reportes", "Importar y exportar"]);
    assert.deepEqual(menu(admin).map((g) => g.heading), [null, "Ventas", "Producto y stock", "Finanzas", "Equipo", "Reportes"]);
  });

  it("cada botón que junta pantallas tiene sus pestañas", () => {
    const admin = profile("admin");
    assert.deepEqual(item(admin, "Stock")!.tabs.map((t) => t.label), ["Stock", "Recetas"]);
    assert.deepEqual(item(admin, "Bancos")!.tabs.map((t) => t.label), ["Conciliación", "Cheques"]);
    assert.deepEqual(item(admin, "Contable")!.tabs.map((t) => t.label), ["Contable", "Facturas"]);
    assert.deepEqual(item(admin, "Reportes")!.tabs.map((t) => t.label), ["Reportes", "Rentabilidad"]);
    assert.deepEqual(item(admin, "Importar y exportar")!.tabs.map((t) => t.label), ["Importar", "Exportar"]);
  });

  it("plan Estándar: sin Contable ni Bancos, el botón dice Facturas y abre Facturas", () => {
    const l = labels(profile("admin", "estandar"));
    assert.ok(l.includes("Facturas"));
    assert.ok(!l.includes("Contable"));
    assert.ok(!l.includes("Bancos"));
    assert.equal(item(profile("admin", "estandar"), "Facturas")!.page, "invoicing");
  });

  it("la cajera sigue viendo solo lo suyo (Productos aparte)", () => {
    const l = labels(profile("cashier"));
    assert.ok(l.includes("Mostrador"));
    assert.ok(l.includes("Productos"));
    for (const hidden of ["Bancos", "Contable", "Tesorería", "Importar y exportar"]) assert.ok(!l.includes(hidden), hidden);
  });

  it("las pantallas a pedido aparecen solo si la empresa las tiene", () => {
    assert.ok(!labels(profile("admin")).includes("Frigorífico"));
    assert.ok(labels(profile("admin", "full", ["frigorifico", "gastos"])).includes("Frigorífico"));
    assert.ok(labels(profile("admin", "full", ["frigorifico", "gastos"])).includes("Gastos"));
  });
});
