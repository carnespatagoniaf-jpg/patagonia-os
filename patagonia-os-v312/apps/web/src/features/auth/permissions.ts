import type { UserProfile } from "./AuthProvider";

export type Permission =
  | "dashboard.view"
  | "pos.sell"
  | "sales.create"
  | "sales.cancel"
  | "inventory.view"
  | "inventory.adjust"
  | "purchases.manage"
  | "treasury.manage"
  | "employees.manage"
  | "profitability.view"
  | "carcass.manage"
  | "creditors.manage"
  | "reports.view"
  | "users.manage"
  | "branches.manage"
  | "audit.view";

// "owner" es interno nuestro (el equipo de Patagonia OS): ve todo, incluidas
// herramientas todavía en prueba (Mostrador, Usuarios, Auditoría) antes de
// decidir si pasan a formar parte de lo que se le vende a un cliente.
// "admin" es el techo de lo que tiene un cliente real: todo el paquete
// comercial, sin las herramientas internas de arriba.
const rolePermissions: Record<UserProfile["role"], (Permission | "*")[]> = {
  owner: ["*"],
  admin: [
    "dashboard.view",
    "sales.create",
    "sales.cancel",
    "inventory.view",
    "inventory.adjust",
    "purchases.manage",
    "treasury.manage",
    "employees.manage",
    "profitability.view",
    "carcass.manage",
    "creditors.manage",
    "reports.view",
    "branches.manage"
  ],
  manager: ["dashboard.view", "sales.create", "sales.cancel", "inventory.view", "inventory.adjust", "purchases.manage", "reports.view"],
  cashier: ["dashboard.view", "sales.create", "inventory.view"],
  production: ["dashboard.view", "inventory.view", "inventory.adjust"],
  readonly: ["dashboard.view", "inventory.view", "reports.view"]
};

export function can(profile: UserProfile | null, permission: Permission) {
  if (!profile) return false;
  const permissions = rolePermissions[profile.role];
  return permissions.includes("*") || permissions.includes(permission);
}

/** Permiso requerido para cada página del menú — fuente única de verdad para el tipo Page. */
export const PAGE_PERMISSIONS = {
  dashboard: "dashboard.view",
  sale: "pos.sell",
  shifts: "sales.create",
  inventory: "inventory.view",
  purchases: "purchases.manage",
  treasury: "treasury.manage",
  employees: "employees.manage",
  profitability: "profitability.view",
  carcass: "carcass.manage",
  creditors: "creditors.manage",
  reports: "reports.view",
  users: "users.manage",
  audit: "audit.view"
} as const satisfies Record<string, Permission>;

export type Page = keyof typeof PAGE_PERMISSIONS;

export function canAccessPage(profile: UserProfile | null, page: Page) {
  return can(profile, PAGE_PERMISSIONS[page]);
}
