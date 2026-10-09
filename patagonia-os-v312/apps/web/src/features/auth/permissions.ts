import type { UserProfile } from "./AuthProvider";

export type Permission =
  | "dashboard.view"
  | "pos.sell"
  | "products.view"
  | "sales.create"
  | "sales.cancel"
  | "inventory.view"
  | "inventory.adjust"
  | "purchases.manage"
  | "treasury.manage"
  | "pos.treasury"
  | "employees.manage"
  | "profitability.view"
  | "carcass.manage"
  | "recipes.manage"
  | "creditors.manage"
  | "customers.manage"
  | "reports.view"
  | "users.manage"
  | "branches.manage"
  | "audit.view"
  | "import.data"
  | "scales.manage";

// "owner" es interno nuestro (el equipo de Patagonia OS): ve todo, incluidas
// herramientas todavía en prueba (Auditoría) antes de decidir si pasan a
// formar parte de lo que se le vende a un cliente.
// "admin" es el techo de lo que tiene un cliente real: todo el paquete
// comercial. Usuarios (users.manage) pasó a admin para que un cliente con
// varias sucursales pueda dar de alta sus propios cajeros/encargados sin
// depender de nosotros — la pantalla ya limita los roles asignables a
// no-owner (ver ASSIGNABLE_ROLES en features/users/Users.tsx) y el
// RPC/Edge Function del lado del servidor también lo validan. Auditoría
// sigue reservada a "owner".
// "cashier" es justamente el rol pensado para el empleado que atiende el
// mostrador: solo ve Mostrador, Ventas y Productos, nada más — ni Inicio,
// ni Stock, ni (por supuesto) Tesorería/Compras/Empleados. No hace falta
// una pantalla aparte para ocultarle el resto, alcanza con darle de alta
// como "Cajero" (no "Admin") en Usuarios.
// "pos.treasury" es un permiso angosto a propósito: solo destraba los
// botones de Mostrador para cargar Movimiento de caja / Pago a proveedor /
// Vale a empleado durante el turno (y sus comprobantes). No es lo mismo que
// "treasury.manage" -- ese sigue siendo el único que abre la pantalla
// completa de Tesorería (todas las cuentas, saldos y traspasos de la
// empresa), que un cajero no debería ver. El backend (RPCs
// adjust_treasury_account / register_pos_shift_transfer /
// register_supplier_payment_from_pos_shift / register_employee_vale_from_pos_shift)
// no exige ningún rol puntual -- ya alcanzaba con pertenecer a la empresa y
// tener un turno abierto -- así que este permiso es la única traba real y
// se puede sumar sin tocar SQL.
// "products.view" es distinto de "inventory.view" (Stock): Productos es de
// solo lectura y nunca muestra costo/margen (solo nombre y precio de
// venta, con opción de imprimir una etiqueta para la góndola) — pensada
// para que el cajero conteste "¿cuánto sale esto?" sin pasar por Mostrador
// ni ver información sensible de costos.
export const rolePermissions: Record<UserProfile["role"], (Permission | "*")[]> = {
  owner: ["*"],
  admin: [
    "dashboard.view",
    "pos.sell",
    "products.view",
    "sales.create",
    "sales.cancel",
    "inventory.view",
    "inventory.adjust",
    "purchases.manage",
    "treasury.manage",
    "pos.treasury",
    "employees.manage",
    "profitability.view",
    "carcass.manage",
    "recipes.manage",
    "creditors.manage",
    "customers.manage",
    "reports.view",
    "branches.manage",
    "users.manage",
    "import.data",
    "scales.manage"
  ],
  manager: ["dashboard.view", "sales.create", "sales.cancel", "inventory.view", "inventory.adjust", "purchases.manage", "reports.view"],
  cashier: ["pos.sell", "products.view", "sales.create", "pos.treasury"],
  production: ["dashboard.view", "inventory.view", "inventory.adjust"],
  readonly: ["dashboard.view", "inventory.view", "reports.view"]
};

/** Etiqueta en español para cada permiso — usada en Usuarios para armar los tildes de "qué puede ver esta persona en particular". */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "dashboard.view": "Inicio",
  "pos.sell": "Mostrador",
  "products.view": "Productos",
  "sales.create": "Turnos / Ventas",
  "sales.cancel": "Anular ventas",
  "inventory.view": "Stock",
  "inventory.adjust": "Ajustar stock",
  "purchases.manage": "Compras y proveedores",
  "treasury.manage": "Tesorería",
  "pos.treasury": "Movimientos de caja en Mostrador (caja, proveedor, vale)",
  "employees.manage": "Empleados",
  "profitability.view": "Rentabilidad",
  "carcass.manage": "Despiece",
  "recipes.manage": "Recetas (costos de productos elaborados)",
  "creditors.manage": "Deudas (deudores)",
  "customers.manage": "Clientes",
  "reports.view": "Reportes",
  "users.manage": "Usuarios",
  "branches.manage": "Sucursales",
  "audit.view": "Auditoría",
  "import.data": "Importar desde Excel",
  "scales.manage": "Balanzas"
};

/** Planes que se venden (migración 101). El plan de la empresa se chequea
 * también en la base (require_plan en cada función + RLS); esto es para no
 * mostrar lo que el plan no incluye. */
export type Plan = "basico" | "estandar" | "full";

export const PLAN_LABELS: Record<Plan, string> = { basico: "Básico", estandar: "Estándar", full: "Full" };

/** Mismos límites que plan_limits() en la base (null = sin límite). */
export const PLAN_LIMITS: Record<Plan, { maxBranches: number | null; maxUsers: number | null }> = {
  basico: { maxBranches: 1, maxUsers: 3 },
  estandar: { maxBranches: 2, maxUsers: 8 },
  full: { maxBranches: null, maxUsers: null }
};

const PLAN_RANK: Record<Plan, number> = { basico: 1, estandar: 2, full: 3 };

/** Permisos que solo existen desde cierto plan. Lo que no está acá va en todos. */
const PERMISSION_MIN_PLAN: Partial<Record<Permission, Plan>> = {
  "customers.manage": "estandar",
  "employees.manage": "estandar",
  "carcass.manage": "estandar",
  "recipes.manage": "estandar",
  "profitability.view": "estandar",
  "creditors.manage": "estandar",
  "scales.manage": "estandar"
};

/** Páginas que piden un plan más alto que su permiso (ej. Sucursales: el
 * permiso branches.manage también maneja el selector de sucursal, que
 * Estándar necesita, pero la pantalla de resumen es de Full). */
const PAGE_MIN_PLAN: Partial<Record<string, Plan>> = { branches: "full", reconciliation: "full", invoicing: "full" };

/** Plan de la empresa del usuario. Sin dato (modo demo, o la base todavía
 * sin la migración 101) cuenta como Full: nunca se le saca algo a nadie por
 * un dato que falta. */
export function profilePlan(profile: UserProfile | null): Plan {
  const plan = profile?.plan;
  return plan === "basico" || plan === "estandar" || plan === "full" ? plan : "full";
}

export function planAllows(profile: UserProfile | null, min: Plan): boolean {
  return PLAN_RANK[profilePlan(profile)] >= PLAN_RANK[min];
}

export function can(profile: UserProfile | null, permission: Permission) {
  if (!profile) return false;
  const minPlan = PERMISSION_MIN_PLAN[permission];
  if (minPlan && !planAllows(profile, minPlan)) return false;
  const permissions = rolePermissions[profile.role];
  const grantedByRole = permissions.includes("*") || permissions.includes(permission);
  if (!grantedByRole) return false;
  // denied_permissions solo puede sacar permisos que el rol ya daba, nunca agregar.
  return !profile.denied_permissions?.includes(permission);
}

/** Permiso requerido para cada página del menú — fuente única de verdad para el tipo Page. */
export const PAGE_PERMISSIONS = {
  dashboard: "dashboard.view",
  sale: "pos.sell",
  branches: "branches.manage",
  products: "products.view",
  shifts: "sales.create",
  inventory: "inventory.view",
  purchases: "purchases.manage",
  treasury: "treasury.manage",
  reconciliation: "treasury.manage",
  invoicing: "treasury.manage",
  employees: "employees.manage",
  profitability: "profitability.view",
  carcass: "carcass.manage",
  recipes: "recipes.manage",
  scales: "scales.manage",
  creditors: "creditors.manage",
  customers: "customers.manage",
  reports: "reports.view",
  export: "reports.view",
  import: "import.data",
  users: "users.manage",
  audit: "audit.view"
} as const satisfies Record<string, Permission>;

export type Page = keyof typeof PAGE_PERMISSIONS;

export function canAccessPage(profile: UserProfile | null, page: Page) {
  const minPlan = PAGE_MIN_PLAN[page];
  if (minPlan && !planAllows(profile, minPlan)) return false;
  return can(profile, PAGE_PERMISSIONS[page]);
}

/** Primera página del menú a la que el perfil tiene acceso — para no aterrizar a un rol como "cashier" en Inicio, que ya no ve. */
export function firstAccessiblePage(profile: UserProfile | null): Page {
  const order = Object.keys(PAGE_PERMISSIONS) as Page[];
  return order.find((page) => canAccessPage(profile, page)) ?? "dashboard";
}
