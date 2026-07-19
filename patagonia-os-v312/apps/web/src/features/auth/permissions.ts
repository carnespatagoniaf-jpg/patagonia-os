import type { UserProfile } from "./AuthProvider";

export type Permission =
  | "dashboard.view"
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
  | "branches.manage";

const rolePermissions: Record<UserProfile["role"], (Permission | "*")[]> = {
  owner: ["*"],
  admin: ["*"],
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
  shifts: "sales.create",
  inventory: "inventory.view",
  purchases: "purchases.manage",
  treasury: "treasury.manage",
  employees: "employees.manage",
  profitability: "profitability.view",
  carcass: "carcass.manage",
  creditors: "creditors.manage",
  reports: "reports.view"
} as const satisfies Record<string, Permission>;

export type Page = keyof typeof PAGE_PERMISSIONS;

export function canAccessPage(profile: UserProfile | null, page: Page) {
  return can(profile, PAGE_PERMISSIONS[page]);
}
