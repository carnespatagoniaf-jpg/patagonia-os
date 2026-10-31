import { BarChart3, Banknote, Beef, BookOpenCheck, Boxes, ClipboardList, FileText, HandCoins, Handshake, History, Truck, KeyRound, Landmark, MapPin, Upload, PackagePlus, Receipt, Snowflake, Tag, Users, Wallet } from "lucide-react";
import type { Page } from "../features/auth/permissions";

export type NavItem = {
  page: Page;
  label: string;
  icon: typeof BarChart3;
  /**
   * Botón que junta varias pantallas (menú más simple, aprobado por el dueño el 30/10): abre la primera que la persona
   * puede ver y arriba muestra pestañas con las demás. Cada pestaña mantiene su propio permiso y plan. Si la persona
   * puede ver UNA sola, el botón lleva el nombre de esa pantalla (una cajera o un plan Estándar no ven "Contable" si
   * solo tienen Facturas).
   */
  tabs?: Array<{ page: Page; label: string }>;
};

/** Agrupado por tarea (no por tabla/permiso) para que el menú no sea una
 * lista plana de 15 ítems -- las tres pantallas de venta (Mostrador, Turnos,
 * Clientes) quedan juntas en vez de dispersas, etc. "Inicio" va suelto,
 * sin encabezado de grupo. */
export const navGroups: Array<{ heading: string | null; items: NavItem[] }> = [
  { heading: null, items: [{ page: "dashboard", label: "Inicio", icon: BarChart3 }] },
  {
    heading: "Ventas",
    items: [
      { page: "sale", label: "Mostrador", icon: Receipt },
      { page: "route", label: "Venta en ruta", icon: Truck },
      { page: "route_trucks", label: "Camiones", icon: Truck },
      { page: "customers", label: "Clientes", icon: Handshake },
      { page: "sales_report", label: "Reporte de ventas", icon: ClipboardList }
    ]
  },
  {
    heading: "Producto y stock",
    items: [
      { page: "products", label: "Productos", icon: Tag },
      { page: "inventory", label: "Stock", icon: Boxes, tabs: [{ page: "inventory", label: "Stock" }, { page: "recipes", label: "Recetas" }] },
      { page: "purchases", label: "Compras", icon: PackagePlus },
      { page: "carcass", label: "Despiece", icon: Beef },
      // Solo para la empresa con 'frigorifico' en companies.features (migración 169).
      { page: "frigorifico", label: "Frigorífico", icon: Snowflake }
      // "Balanzas" (features/scales, el Scale Manager) está escondida desde el
      // 2026-09-30: duplicaba lo que ya
      // anda (Productos/Stock → "Balanza por cable" y el engranaje de
      // Mostrador). Se vuelve a mostrar agregando acá
      // la entrada de la página "scales" con el ícono Scale (importándolo)
      // si se decide que sea el único lugar (el envío de precios se probó una vez
      // con una Kretz Report LT real; el peso de la Aura, nunca).
    ]
  },
  {
    heading: "Finanzas",
    items: [
      { page: "treasury", label: "Tesorería", icon: Wallet },
      { page: "accounts", label: "Reporte de cuentas", icon: ClipboardList },
      { page: "expenses", label: "Gastos", icon: Banknote },
      { page: "reconciliation", label: "Bancos", icon: Landmark, tabs: [{ page: "reconciliation", label: "Conciliación" }, { page: "cheques", label: "Cheques" }] },
      { page: "accounting", label: "Contable", icon: BookOpenCheck, tabs: [{ page: "accounting", label: "Contable" }, { page: "invoicing", label: "Facturas" }] },
      { page: "creditors", label: "Deudas", icon: HandCoins }
    ]
  },
  {
    heading: "Equipo",
    items: [
      { page: "branches", label: "Sucursales", icon: MapPin },
      { page: "employees", label: "Empleados", icon: Users },
      { page: "users", label: "Usuarios", icon: KeyRound }
    ]
  },
  {
    heading: "Reportes",
    items: [
      { page: "reports", label: "Reportes", icon: FileText, tabs: [{ page: "reports", label: "Reportes" }, { page: "profitability", label: "Rentabilidad" }] },
      { page: "import", label: "Importar y exportar", icon: Upload, tabs: [{ page: "import", label: "Importar" }, { page: "export", label: "Exportar" }] },
      { page: "audit", label: "Auditoría", icon: History }
    ]
  }
];

export type VisibleItem = { page: Page; label: string; icon: typeof BarChart3; pages: Page[]; tabs: Array<{ page: Page; label: string }> };

/** El botón tal como lo ve esta persona: solo las pestañas que puede abrir; null si no puede abrir ninguna. */
export function visibleItem(item: NavItem, allowed: (page: Page) => boolean): VisibleItem | null {
  if (!item.tabs) return allowed(item.page) ? { page: item.page, label: item.label, icon: item.icon, pages: [item.page], tabs: [] } : null;
  const tabs = item.tabs.filter((t) => allowed(t.page));
  if (tabs.length === 0) return null;
  return { page: tabs[0].page, label: tabs.length === 1 ? tabs[0].label : item.label, icon: item.icon, pages: tabs.map((t) => t.page), tabs };
}

