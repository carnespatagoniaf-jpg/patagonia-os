import type { UserProfile } from "./AuthProvider";

export type Permission =
  | "dashboard.view"
  | "sales.create"
  | "sales.cancel"
  | "inventory.view"
  | "inventory.adjust"
  | "purchases.manage"
  | "users.manage";

const rolePermissions: Record<UserProfile["role"], (Permission | "*")[]> = {
  owner: ["*"],
  admin: ["dashboard.view","sales.create","sales.cancel","inventory.view","inventory.adjust","purchases.manage","users.manage"],
  manager: ["dashboard.view","sales.create","sales.cancel","inventory.view","inventory.adjust","purchases.manage"],
  cashier: ["dashboard.view","sales.create","inventory.view"],
  production: ["dashboard.view","inventory.view","inventory.adjust"],
  readonly: ["dashboard.view","inventory.view"]
};

export function can(profile: UserProfile | null, permission: Permission) {
  if (!profile) return false;
  const permissions = rolePermissions[profile.role];
  return permissions.includes("*") || permissions.includes(permission);
}
