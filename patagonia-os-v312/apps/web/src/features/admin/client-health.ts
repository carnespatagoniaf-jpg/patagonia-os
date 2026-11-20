/**
 * Etapa 4 del rediseño del panel (20/11/2026): semáforo de cada cliente y a quién venderle más.
 * Lógica pura (sin Supabase), testeada en client-health.test.ts. Solo usa datos que el panel ya trae:
 * el cobro (company-billing), el uso (list_sales_pipeline_for_admin) y el plan.
 */
import type { CompanyUsage } from "./sales-pipeline";

export type HealthLevel = "ok" | "warn" | "risk";

export interface HealthInput {
  createdAt: string;
  /** Abono vencido, prueba vencida sin pago o Mercado Pago que no pudo cobrar. */
  owes: boolean;
  usage?: CompanyUsage;
}

export interface Health {
  level: HealthLevel;
  /** Lo que pasa, en palabras, lo más grave primero. Vacío = está bien. */
  reasons: string[];
  /** Variación de ventas de los últimos 7 días contra el promedio semanal de antes (null = no hay con qué comparar). */
  salesChangePct: number | null;
}

const DAY = 86_400_000;

function daysSince(iso: string | null | undefined, now: number): number | null {
  return iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY)) : null;
}

/**
 * Promedio semanal de ventas ANTES de los últimos 7 días, para comparar contra esta semana.
 * Necesita al menos 2 semanas vendiendo; si no, null.
 */
export function previousWeeklyAverage(usage: CompanyUsage, now: number): number | null {
  const since = daysSince(usage.firstSaleAt, now);
  if (since === null || since < 14) return null;
  const weeksBefore = (since - 7) / 7;
  const before = usage.saleCount - usage.salesLast7d;
  return weeksBefore > 0 ? before / weeksBefore : null;
}

/** Semáforo del cliente: verde (bien), amarillo (mirar) o rojo (puede irse). */
export function clientHealth(input: HealthInput, now: number = Date.now()): Health {
  const risk: string[] = [];
  const warn: string[] = [];
  const u = input.usage;
  const age = daysSince(input.createdAt, now) ?? 0;
  let salesChangePct: number | null = null;

  if (u) {
    const lastSale = daysSince(u.lastSaleAt, now);
    if (u.productCount === 0) {
      (age >= 3 ? risk : warn).push("No cargó productos");
    } else if (lastSale === null) {
      (age >= 7 ? risk : warn).push("Cargó productos pero nunca vendió");
    } else if (lastSale >= 14) {
      risk.push(`No vende hace ${lastSale} días`);
    } else if (lastSale >= 7) {
      warn.push(`No vende hace ${lastSale} días`);
    }

    const avg = previousWeeklyAverage(u, now);
    if (avg !== null && avg >= 20 && lastSale !== null && lastSale < 7) {
      salesChangePct = Math.round(((u.salesLast7d - avg) / avg) * 100);
      const text = `Vende menos: ${u.salesLast7d} ventas esta semana, antes unas ${Math.round(avg)}`;
      if (u.salesLast7d < avg * 0.25) risk.push(text);
      else if (u.salesLast7d < avg * 0.5) warn.push(text);
    }

    const signIn = daysSince(u.lastSignInAt, now);
    if (signIn !== null && signIn >= 21) warn.push(`Nadie entra al sistema hace ${signIn} días`);
  }

  if (input.owes) (risk.length > 0 ? risk : warn).push("Debe el abono");

  const level: HealthLevel = risk.length > 0 ? "risk" : warn.length > 0 ? "warn" : "ok";
  return { level, reasons: [...risk, ...warn], salesChangePct };
}

export const HEALTH_LABEL: Record<HealthLevel, string> = { ok: "Bien", warn: "Mirar", risk: "En riesgo" };

/** Orden para la columna: primero los que están peor. */
export const HEALTH_RANK: Record<HealthLevel, number> = { risk: 0, warn: 1, ok: 2 };

// ── A quién venderle más ────────────────────────────────

export const PRICE_PER_LOCAL = 39000;

export interface UpsellInput {
  id: string;
  name: string;
  plan: "basico" | "estandar" | "full" | "empresa" | "planta" | null;
  activeBranches: number;
  lastPaymentAmount: number | null;
  /** true = paga por suscripción de Mercado Pago (el monto lo cobra MP). */
  autoCharged: boolean;
  usage?: CompanyUsage;
}

export interface Upsell {
  companyId: string;
  /** Qué ofrecerle, en una línea. */
  offer: string;
  /** Por qué, con el dato. */
  reason: string;
}

/**
 * Oportunidades de venta, mirando las pantallas que le faltan y los locales que tiene (no los topes de usuarios:
 * los planes cuestan lo mismo y solo cambian las pantallas; dueño 03/11/2026).
 */
export function upsellCandidates(list: UpsellInput[]): Upsell[] {
  const out: Upsell[] = [];
  for (const c of list) {
    const weekly = c.usage?.salesLast7d ?? 0;
    if (c.plan === "basico") {
      out.push({ companyId: c.id, offer: "Pasarlo a Estándar", reason: "Básico ya no se vende; Estándar le suma facturas, sucursales y camiones." });
    } else if (c.plan === "estandar" && weekly >= 150) {
      out.push({ companyId: c.id, offer: "Ofrecerle Full", reason: `Vende mucho (${weekly} ventas en 7 días): Full le suma conciliación de bancos, cheques y libro contable.` });
    }
    if (c.activeBranches >= 2 && c.plan !== "empresa" && c.plan !== "planta") {
      out.push({ companyId: c.id, offer: "Ofrecerle Empresa", reason: `Tiene ${c.activeBranches} locales: Empresa le suma mercadería entre locales y personal por sucursal.` });
    }
    if (c.activeBranches >= 2 && !c.autoCharged && c.lastPaymentAmount !== null && c.lastPaymentAmount < PRICE_PER_LOCAL * c.activeBranches) {
      out.push({
        companyId: c.id,
        offer: "Revisar el abono",
        reason: `Tiene ${c.activeBranches} locales y su último pago fue de $${c.lastPaymentAmount.toLocaleString("es-AR")} (a $39.000 por local serían $${(PRICE_PER_LOCAL * c.activeBranches).toLocaleString("es-AR")}).`
      });
    }
  }
  return out;
}

/** Mensaje de WhatsApp para un cliente que está dejando de usar el sistema. */
export function healthMessage(brandName: string, business: string, ownerFullName: string | null, health: Health): string {
  const first = ownerFullName?.trim().split(/\s+/)[0];
  const hi = `¡Hola${first ? ` ${first}` : ""}!`;
  const top = health.reasons[0] ?? "";
  if (top.startsWith("No cargó productos")) {
    return `${hi} Soy de ${brandName}. Vi que todavía no cargaste los productos de ${business}. Si me mandás tu lista de precios (foto o Excel), te la cargo yo así arrancás hoy.`;
  }
  if (top.startsWith("Cargó productos pero nunca vendió")) {
    return `${hi} Ya tenés los productos cargados en ${brandName}. ¿Probaste hacer una venta desde Mostrador? Si querés lo vemos juntos en 10 minutos.`;
  }
  if (top === "Debe el abono") {
    return `${hi} Soy de ${brandName}. Te escribo por el abono de ${business}, que está vencido. ¿Lo pudiste pagar? Si necesitás los datos para transferir, te los paso.`;
  }
  return `${hi} ¿Cómo va todo en ${business}? Vi que estos días se registraron menos ventas en ${brandName}. ¿Está todo bien con el sistema? Si algo no anda o les cuesta, decime y lo resolvemos.`;
}
