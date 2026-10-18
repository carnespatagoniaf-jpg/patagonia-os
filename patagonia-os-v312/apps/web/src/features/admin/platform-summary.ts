/** Pestaña "Resumen" del panel de plataforma (migración 130).
 * Lógica pura, sin lib/supabase, para poder testearla. */

import type { BillingInfo } from "./company-billing";

/** Nombre de cada pantalla como lo ve el cliente en el menú (Layout.tsx). */
export const PAGE_LABELS: Record<string, string> = {
  dashboard: "Inicio",
  sale: "Mostrador",
  customers: "Clientes (fiado)",
  products: "Productos",
  inventory: "Stock",
  purchases: "Compras",
  carcass: "Despiece",
  recipes: "Recetas",
  treasury: "Tesorería",
  reconciliation: "Conciliación",
  invoicing: "Facturas",
  creditors: "Deudas",
  profitability: "Rentabilidad",
  branches: "Sucursales",
  employees: "Empleados",
  users: "Usuarios",
  reports: "Reportes",
  export: "Exportar",
  import: "Importar",
  audit: "Auditoría",
  shifts: "Turnos",
  scales: "Balanzas"
};

export function pageLabel(page: string) {
  return PAGE_LABELS[page] ?? page;
}

/** Variación en % entre este mes y el anterior. null si el anterior fue 0. */
export function monthChangePct(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function daysBetween(fromIso: string, toIso: string) {
  return Math.round((Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

export interface UsageLike {
  lastSignInAt: string | null;
  lastSaleAt: string | null;
  saleCount: number;
}

export interface RiskItem {
  companyId: string;
  reason: string;
  days: number;
}

/** Días sin uso a partir de los cuales un cliente aparece "en riesgo". */
export const RISK_DAYS = 7;

/** Clientes activos que dejaron de usar el sistema: no entran hace RISK_DAYS días,
 * o vendían y dejaron de vender. Los que nunca usaron nada no cuentan acá
 * (eso es la pestaña Ventas). Los más abandonados primero. */
export function riskList<T extends { id: string; active: boolean }>(
  companies: T[],
  usage: Record<string, UsageLike | undefined>,
  todayIso: string,
  limit = 5
): RiskItem[] {
  const out: RiskItem[] = [];
  for (const c of companies) {
    if (!c.active) continue;
    const u = usage[c.id];
    if (!u) continue;
    const signIn = u.lastSignInAt ? daysBetween(u.lastSignInAt, todayIso) : null;
    const sale = u.saleCount > 0 && u.lastSaleAt ? daysBetween(u.lastSaleAt, todayIso) : null;
    if (signIn !== null && signIn >= RISK_DAYS) {
      out.push({ companyId: c.id, reason: `no entra hace ${signIn} días`, days: signIn });
    } else if (sale !== null && sale >= RISK_DAYS) {
      out.push({ companyId: c.id, reason: `no vende hace ${sale} días`, days: sale });
    }
  }
  return out.sort((a, b) => b.days - a.days).slice(0, limit);
}

export interface PlanUsage {
  plan: "basico" | "estandar" | "full";
  activeBranches: number;
  activeUsers: number;
}

export interface PlanLimits {
  maxBranches: number | null;
  maxUsers: number | null;
}

/** Clientes que llegaron al tope de usuarios de su plan (no Full), o al de
 * sucursales cuando el plan permite más de una (en Básico todos usan su única
 * sucursal: eso no dice nada). */
export function upgradeCandidates(
  companyIds: string[],
  plans: Record<string, PlanUsage | undefined>,
  limits: Record<string, PlanLimits>
): { companyId: string; reason: string }[] {
  const out: { companyId: string; reason: string }[] = [];
  for (const id of companyIds) {
    const p = plans[id];
    if (!p || p.plan === "full") continue;
    const l = limits[p.plan];
    if (!l) continue;
    const reasons: string[] = [];
    if (l.maxUsers !== null && p.activeUsers >= l.maxUsers) reasons.push(`${p.activeUsers} de ${l.maxUsers} usuarios`);
    if (l.maxBranches !== null && l.maxBranches > 1 && p.activeBranches >= l.maxBranches) reasons.push(`${p.activeBranches} de ${l.maxBranches} sucursales`);
    if (reasons.length) out.push({ companyId: id, reason: `usa ${reasons.join(" y ")}` });
  }
  return out;
}

/** Clientes cuyo abono vence entre hoy y dentro de `days` días, el más próximo primero.
 * `skip` = los que se cobran solos (suscripción al día). */
export function dueSoonList<T extends BillingInfo & { id: string; active: boolean }>(
  companies: T[],
  todayIso: string,
  skip: (c: T) => boolean,
  days = 7
): { company: T; days: number }[] {
  return companies
    .filter((c) => c.active && c.paidUntil && !skip(c))
    .map((c) => ({ company: c, days: daysBetween(todayIso, c.paidUntil!) }))
    .filter((x) => x.days >= 0 && x.days <= days)
    .sort((a, b) => a.days - b.days);
}
