import { supabase } from "../../lib/supabase";
import type { Plan } from "../auth/permissions";
import type { CompanyUsage, Lead, LeadStage } from "./sales-pipeline";
import type { MpSubscription } from "./mercadopago";
import type { Currency, FinKind, FinOverview, FinPartner } from "./finance";

export interface CreateClientInput {
  companyName: string;
  branchName: string;
  ownerFullName: string;
  ownerEmail: string;
  contactPhone?: string;
}

export interface CreateClientResult {
  companyId: string;
  branchId: string;
  ownerId: string;
  email: string;
  tempPassword: string;
}

export async function createClient(input: CreateClientInput): Promise<CreateClientResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.functions.invoke("create-client", { body: input });
  if (error) {
    let message = error.message;
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        if (body?.error) message = body.error;
      } catch {
        // keep default message
      }
    }
    throw new Error(message);
  }
  if (!data || (data as { error?: string }).error) {
    throw new Error((data as { error?: string })?.error ?? "No se pudo crear el cliente.");
  }
  return data as CreateClientResult;
}

export interface CompanySummary {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  branchCount: number;
  userCount: number;
  /** Dueño real de la empresa (profiles.role = 'owner') -- null si por
   * algún motivo no tiene ningún perfil con ese rol. A diferencia del
   * cartel de "cliente creado" (que solo se ve una vez), esto queda
   * disponible siempre en la tabla de Clientes. */
  /** Usuario (auth) del dueño, para cambiarle la contraseña. null si no tiene. */
  ownerId: string | null;
  ownerFullName: string | null;
  ownerEmail: string | null;
  /** Teléfono de contacto guardado a mano al crear el cliente -- uso interno
   * nuestro (para ubicar a quien pidió la demo), no lo ve el cliente. */
  contactPhone: string | null;
  province: string | null;
  city: string | null;
  /** null = sin vencimiento (cliente pago o excepción). */
  trialEndsAt: string | null;
  /** Número de cliente fijo (migración 110). undefined en una base sin la migración. */
  clientNumber?: number;
  /** Hasta qué día está pagado el abono (YYYY-MM-DD). null = nunca se registró un pago. */
  paidUntil: string | null;
  lastPaymentDate: string | null;
  lastPaymentAmount: number | null;
}

export const PROVINCES = [
  "Buenos Aires", "CABA", "Catamarca", "Chaco", "Chubut", "Córdoba", "Corrientes", "Entre Ríos", "Formosa", "Jujuy",
  "La Pampa", "La Rioja", "Mendoza", "Misiones", "Neuquén", "Río Negro", "Salta", "San Juan", "San Luis",
  "Santa Cruz", "Santa Fe", "Santiago del Estero", "Tierra del Fuego", "Tucumán"
] as const;

export async function setCompanyTrial(companyId: string, trialEndsAt: string | null): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("set_company_trial", { p_company_id: companyId, p_trial_ends_at: trialEndsAt });
  if (error) throw error;
}

export async function setCompanyLocation(companyId: string, province: string, city: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("set_company_location", { p_company_id: companyId, p_province: province, p_city: city });
  if (error) throw error;
}

export async function listCompanies(): Promise<CompanySummary[]> {
  if (!supabase) return [];

  const { data, error } = await supabase.rpc("list_companies_for_admin");
  if (error) throw error;

  interface Row {
    id: string; name: string; active: boolean; created_at: string; branch_count: number; user_count: number;
    owner_id?: string | null; owner_full_name: string | null; owner_email: string | null; contact_phone: string | null;
    province: string | null; city: string | null; trial_ends_at: string | null;
    client_number?: number | null; paid_until?: string | null; last_payment_date?: string | null; last_payment_amount?: number | null;
  }
  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
    createdAt: row.created_at,
    branchCount: Number(row.branch_count),
    userCount: Number(row.user_count),
    ownerId: row.owner_id ?? null,
    ownerFullName: row.owner_full_name,
    ownerEmail: row.owner_email,
    contactPhone: row.contact_phone,
    province: row.province,
    city: row.city,
    trialEndsAt: row.trial_ends_at,
    clientNumber: row.client_number ?? undefined,
    paidUntil: row.paid_until ?? null,
    lastPaymentDate: row.last_payment_date ?? null,
    lastPaymentAmount: row.last_payment_amount === null || row.last_payment_amount === undefined ? null : Number(row.last_payment_amount)
  }));
}

/** Pagos del abono (migración 110). Solo un registro nuestro: no cobra ni bloquea nada. */
export interface CompanyPayment {
  id: string;
  paymentDate: string;
  amount: number | null;
  months: number;
  paidUntil: string;
  note: string | null;
}

export async function registerCompanyPayment(input: { companyId: string; months: number; amount?: number; paymentDate?: string; note?: string }): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("register_company_payment", {
    p_company_id: input.companyId,
    p_months: input.months,
    p_amount: input.amount ?? null,
    p_payment_date: input.paymentDate ?? null,
    p_note: input.note ?? null
  });
  if (error) throw error;
  return data as string;
}

export async function setCompanyPaidUntil(companyId: string, paidUntil: string | null): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("set_company_paid_until", { p_company_id: companyId, p_paid_until: paidUntil });
  if (error) throw error;
}

export async function listCompanyPayments(companyId: string): Promise<CompanyPayment[]> {
  if (!supabase) return [];

  const { data, error } = await supabase.rpc("list_company_payments", { p_company_id: companyId });
  if (error) throw error;
  interface Row { id: string; payment_date: string; amount: number | null; months: number; paid_until: string; note: string | null }
  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    paymentDate: row.payment_date,
    amount: row.amount === null ? null : Number(row.amount),
    months: row.months,
    paidUntil: row.paid_until,
    note: row.note
  }));
}

export async function deleteCompanyPayment(paymentId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_company_payment", { p_payment_id: paymentId });
  if (error) throw error;
}

/** Plan de cada cliente + sucursales y usuarios activos (migración 101). */
export interface CompanyPlanInfo {
  plan: Plan;
  activeBranches: number;
  activeUsers: number;
}

export async function listCompanyPlans(): Promise<Record<string, CompanyPlanInfo>> {
  if (!supabase) return {};

  const { data, error } = await supabase.rpc("list_company_plans");
  if (error) throw error;

  const result: Record<string, CompanyPlanInfo> = {};
  for (const row of (data ?? []) as { company_id: string; plan: Plan; active_branches: number; active_users: number }[]) {
    result[row.company_id] = { plan: row.plan, activeBranches: Number(row.active_branches), activeUsers: Number(row.active_users) };
  }
  return result;
}

/** Pantallas a pedido (companies.features). La base acepta solo estas claves (set_company_feature, migración 169). */
export const COMPANY_FEATURES: { key: string; label: string; short: string }[] = [
  { key: "frigorifico", label: "Frigorífico (stock por tropa, garrón y kilo)", short: "Frigorífico" },
  { key: "cuentas", label: "Reporte de cuentas", short: "Cuentas" },
  { key: "gastos", label: "Gastos", short: "Gastos" },
  { key: "reporte_ventas", label: "Reporte de ventas (ventas a cuenta con detalle)", short: "Reporte de ventas" },
  { key: "ventas_detalle", label: "Descuento o recargo y detalle en ventas a cuenta", short: "Detalle en ventas" },
  { key: "paquetes", label: "Paquetes (cortes envasados) en Stock", short: "Paquetes" },
  { key: "venta_ruta", label: "Venta en ruta y Camiones", short: "Venta en ruta" }
];

export async function listCompanyFeatures(): Promise<Record<string, string[]>> {
  if (!supabase) return {};
  const { data, error } = await supabase.rpc("list_company_features");
  if (error) throw error;
  const result: Record<string, string[]> = {};
  for (const row of (data ?? []) as { company_id: string; features: string[] | null }[]) result[row.company_id] = row.features ?? [];
  return result;
}

export async function setCompanyFeature(companyId: string, feature: string, enabled: boolean): Promise<string[]> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("set_company_feature", { p_company_id: companyId, p_feature: feature, p_enabled: enabled });
  if (error) throw error;
  return (data ?? []) as string[];
}

export async function setCompanyPlan(companyId: string, plan: Plan): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("set_company_plan", { p_company_id: companyId, p_plan: plan });
  if (error) throw error;
}

export async function setCompanyActive(companyId: string, active: boolean): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("set_company_active", { p_company_id: companyId, p_active: active });
  if (error) throw error;
}

/** Borra de verdad un cliente (no solo lo desactiva) -- solo funciona si la
 * empresa nunca tuvo actividad real (ningún producto, venta, compra, etc.
 * cargado). Si ya tiene algo, el servidor rechaza el borrado con un mensaje
 * claro en vez de arriesgarse a perder datos -- ver
 * delete_company_if_unused en la migración 075. */
export async function deleteClient(companyId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.functions.invoke("delete-client", { body: { companyId } });
  if (error) {
    let message = error.message;
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        if (body?.error) message = body.error;
      } catch {
        // keep default message
      }
    }
    throw new Error(message);
  }
  if (!data || (data as { error?: string }).error) {
    throw new Error((data as { error?: string })?.error ?? "No se pudo borrar el cliente.");
  }
}

/** Reportes que mandan los clientes con "Enviar a soporte" desde Balanzas
 * (migración 100). Solo los ve un administrador de plataforma. */
export interface ScaleSupportReport {
  id: string;
  companyId: string;
  companyName: string;
  branchName: string | null;
  userName: string | null;
  note: string | null;
  logText: string;
  connections: unknown[];
  userAgent: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export async function listScaleSupportReports(): Promise<ScaleSupportReport[]> {
  if (!supabase) return [];

  const { data, error } = await supabase.rpc("list_scale_support_reports");
  if (error) throw error;

  interface Row {
    id: string; company_id: string; company_name: string; branch_name: string | null; user_name: string | null;
    note: string | null; log_text: string; connections: unknown; user_agent: string | null; created_at: string; resolved_at: string | null;
  }
  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    branchName: row.branch_name,
    userName: row.user_name,
    note: row.note,
    logText: row.log_text,
    connections: Array.isArray(row.connections) ? row.connections : [],
    userAgent: row.user_agent,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  }));
}

export async function setScaleSupportReportResolved(id: string, resolved: boolean): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("set_scale_support_report_resolved", { p_id: id, p_resolved: resolved });
  if (error) throw error;
}

/** Embudo de ventas (migración 116): uso real de cada cliente, interesados y seguimiento. */
export async function listSalesPipeline(): Promise<Record<string, CompanyUsage>> {
  if (!supabase) return {};

  const { data, error } = await supabase.rpc("list_sales_pipeline_for_admin");
  if (error) throw error;

  interface Row {
    company_id: string; product_count: number; sale_count: number; sales_last_7d: number; first_sale_at: string | null; last_sale_at: string | null;
    closed_shift_count: number; purchase_count: number; last_sign_in_at: string | null; sales_note: string | null; sales_contacted_at: string | null; sales_lost_reason: string | null;
  }
  const result: Record<string, CompanyUsage> = {};
  for (const row of (data ?? []) as Row[]) {
    result[row.company_id] = {
      productCount: Number(row.product_count),
      saleCount: Number(row.sale_count),
      salesLast7d: Number(row.sales_last_7d),
      firstSaleAt: row.first_sale_at,
      lastSaleAt: row.last_sale_at,
      closedShiftCount: Number(row.closed_shift_count),
      purchaseCount: Number(row.purchase_count),
      lastSignInAt: row.last_sign_in_at,
      salesNote: row.sales_note,
      salesContactedAt: row.sales_contacted_at,
      salesLostReason: row.sales_lost_reason
    };
  }
  return result;
}

export async function setCompanySalesFollowup(input: { companyId: string; note: string | null; lostReason: string | null; markContacted: boolean }): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("set_company_sales_followup", {
    p_company_id: input.companyId,
    p_note: input.note,
    p_lost_reason: input.lostReason,
    p_mark_contacted: input.markContacted
  });
  if (error) throw error;
}

export async function listLeads(): Promise<Lead[]> {
  if (!supabase) return [];

  const { data, error } = await supabase.rpc("list_platform_leads");
  if (error) throw error;

  interface Row {
    id: string; business_name: string; contact_name: string | null; phone: string | null; province: string | null; city: string | null;
    stage: LeadStage; source: string | null; note: string | null; next_contact_on: string | null; lost_reason: string | null; company_id: string | null; created_at: string;
    attempts?: number | null; last_contacted_at?: string | null; replied_at?: string | null;
  }
  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    businessName: row.business_name,
    contactName: row.contact_name,
    phone: row.phone,
    province: row.province,
    city: row.city,
    stage: row.stage,
    source: row.source,
    note: row.note,
    nextContactOn: row.next_contact_on,
    lostReason: row.lost_reason,
    companyId: row.company_id,
    createdAt: row.created_at,
    attempts: row.attempts ?? 0,
    lastContactedAt: row.last_contacted_at ?? null,
    repliedAt: row.replied_at ?? null
  }));
}

export type LeadInput = Omit<Lead, "id" | "createdAt"> & { id: string | null };

export async function saveLead(lead: LeadInput): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("save_platform_lead", {
    p_id: lead.id,
    p_business_name: lead.businessName,
    p_contact_name: lead.contactName,
    p_phone: lead.phone,
    p_province: lead.province,
    p_city: lead.city,
    p_stage: lead.stage,
    p_source: lead.source,
    p_note: lead.note,
    p_next_contact_on: lead.nextContactOn,
    p_lost_reason: lead.lostReason,
    p_company_id: lead.companyId
  });
  if (error) throw error;
  return data as string;
}

export async function deleteLead(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("delete_platform_lead", { p_id: id });
  if (error) throw error;
}

// --- Suscripciones de Mercado Pago (migración 129, Edge Function mp-sync) ---

export interface MpSyncResult {
  /** false = falta cargar el secreto MP_ACCESS_TOKEN en Supabase. */
  connected: boolean;
  subscriptions?: number;
  charges?: number;
  applied?: number;
}

export async function syncMercadoPago(): Promise<MpSyncResult> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.functions.invoke("mp-sync", { body: {} });
  if (error) {
    let message = error.message;
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        if (body?.error) message = body.error;
      } catch {
        // keep default message
      }
    }
    throw new Error(message);
  }
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  return data as MpSyncResult;
}

export async function listMpSubscriptions(): Promise<MpSubscription[]> {
  if (!supabase) return [];

  const { data, error } = await supabase.rpc("list_mp_subscriptions_for_admin");
  if (error) throw error;
  interface Row {
    id: string; company_id: string | null; company_name: string | null; status: string | null; reason: string | null;
    payer_name: string | null; payer_email: string | null; amount: number | null; date_created: string | null; next_payment_date: string | null;
    last_charge_date: string | null; last_charge_status: string | null; last_payment_status: string | null; last_payment_status_detail: string | null;
    last_retry_attempt: number | null; approved_count: number; synced_at: string | null;
  }
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    companyId: r.company_id,
    companyName: r.company_name,
    status: r.status,
    reason: r.reason,
    payerName: r.payer_name,
    payerEmail: r.payer_email,
    amount: r.amount === null ? null : Number(r.amount),
    dateCreated: r.date_created,
    nextPaymentDate: r.next_payment_date,
    lastChargeDate: r.last_charge_date,
    lastChargeStatus: r.last_charge_status,
    lastPaymentStatus: r.last_payment_status,
    lastPaymentStatusDetail: r.last_payment_status_detail,
    lastRetryAttempt: r.last_retry_attempt,
    approvedCount: Number(r.approved_count),
    syncedAt: r.synced_at
  }));
}

/** Devuelve cuántos cobros sumó al asignar. companyId null = desasignar. */
export async function assignMpSubscription(subscriptionId: string, companyId: string | null): Promise<number> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("assign_mp_subscription", { p_subscription_id: subscriptionId, p_company_id: companyId });
  if (error) throw error;
  return Number(data ?? 0);
}

/** Le pone una contraseña temporal nueva a un usuario (Edge Function admin-reset-password). */
export async function resetUserPassword(userId: string): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.functions.invoke("admin-reset-password", { body: { userId } });
  if (error) {
    let message = error.message;
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        if (body?.error) message = body.error;
      } catch {
        // keep default message
      }
    }
    throw new Error(message);
  }
  const result = data as { tempPassword?: string; error?: string } | null;
  if (!result?.tempPassword) throw new Error(result?.error ?? "No se pudo cambiar la contraseña.");
  return result.tempPassword;
}

// --- Resumen (migración 130) ---

export interface PlatformSummary {
  monthly: { month: string; amount: number; count: number }[];
  newThisMonth: number;
  lostThisMonth: string[];
  trials60d: number;
  trials60dPaid: number;
  /** Desde qué día se registra el uso de pantallas (null = todavía nada). */
  usageSince: string | null;
  usage30d: { page: string; companies: number }[];
  unanswered7d: { question: string; count: number; companies: string[] }[];
}

export async function getPlatformSummary(): Promise<PlatformSummary> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("get_platform_summary");
  if (error) throw error;
  const d = (data ?? {}) as Record<string, unknown>;
  const arr = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  return {
    monthly: arr<{ month: string; amount: number; count: number }>(d.monthly).map((m) => ({ month: m.month, amount: Number(m.amount), count: Number(m.count) })),
    newThisMonth: Number(d.new_this_month ?? 0),
    lostThisMonth: arr<string>(d.lost_this_month),
    trials60d: Number(d.trials_60d ?? 0),
    trials60dPaid: Number(d.trials_60d_paid ?? 0),
    usageSince: (d.usage_since as string | null) ?? null,
    usage30d: arr<{ page: string; companies: number }>(d.usage_30d).map((u) => ({ page: u.page, companies: Number(u.companies) })),
    unanswered7d: arr<{ question: string; count: number; companies: string[] | null }>(d.unanswered_7d).map((q) => ({ question: q.question, count: Number(q.count), companies: q.companies ?? [] }))
  };
}

export interface AdminPaymentRow {
  clientNumber: number | null;
  companyName: string;
  paymentDate: string;
  amount: number | null;
  months: number;
  paidUntil: string;
  note: string | null;
}

export async function listPaymentsForAdmin(from: string, to: string): Promise<AdminPaymentRow[]> {
  if (!supabase) return [];

  const { data, error } = await supabase.rpc("list_payments_for_admin", { p_from: from, p_to: to });
  if (error) throw error;
  interface Row { client_number: number | null; company_name: string; payment_date: string; amount: number | null; months: number; paid_until: string; note: string | null }
  return ((data ?? []) as Row[]).map((r) => ({
    clientNumber: r.client_number,
    companyName: r.company_name,
    paymentDate: r.payment_date,
    amount: r.amount === null ? null : Number(r.amount),
    months: r.months,
    paidUntil: r.paid_until,
    note: r.note
  }));
}

/** Carga muchos interesados de una vez (migración 132). Saltea los que ya están. */
export async function importLeads(rows: { name: string | null; phone: string; attempts?: number; replied?: boolean; lost_reason?: string; note?: string }[], source: string, perDay: number): Promise<{ inserted: number; skipped: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("import_platform_leads", { p_rows: rows, p_source: source, p_per_day: perDay });
  if (error) throw error;
  const r = (data ?? {}) as { inserted?: number; skipped?: number };
  return { inserted: Number(r.inserted ?? 0), skipped: Number(r.skipped ?? 0) };
}

/** "Ya le escribí": suma un intento y agenda el próximo. Devuelve "perdido" al 4.º sin respuesta. */
export async function markLeadContacted(id: string): Promise<"agendado" | "perdido"> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("mark_lead_contacted", { p_id: id });
  if (error) throw error;
  return data === "perdido" ? "perdido" : "agendado";
}

export async function markLeadReplied(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { error } = await supabase.rpc("mark_lead_replied", { p_id: id });
  if (error) throw error;
}

/** Vuelve a poner a estos interesados en "Para escribir hoy", de a perDay por día (migración 133). */
export async function scheduleLeads(ids: string[], perDay: number): Promise<number> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("schedule_leads", { p_ids: ids, p_per_day: perDay });
  if (error) throw error;
  return Number(data ?? 0);
}

// ── Finanzas de Patagonia (migración 158) ─────────────────────────────────────

async function finRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export async function getFinanceOverview(month: string): Promise<FinOverview> {
  await finRpc<number>("fin_apply_recurring", {}).catch(() => 0);
  const data = await finRpc<FinOverview>("fin_overview", { p_month: `${month}-01` });
  const num = (v: unknown) => Number(v ?? 0);
  return {
    ...data,
    accounts: data.accounts.map((a) => ({ ...a, openingBalance: num(a.openingBalance), balance: num(a.balance) })),
    partners: data.partners.map((p) => ({ ...p, sharePct: num(p.sharePct) })),
    recurring: data.recurring.map((r) => ({ ...r, amount: num(r.amount) })),
    movements: data.movements.map((m) => ({ ...m, amount: num(m.amount) }))
  };
}

export function saveFinanceAccount(input: { id: string | null; name: string; currency: Currency; openingBalance: number; receivesPayments: boolean; active?: boolean }) {
  return finRpc<string>("fin_save_account", { p_id: input.id, p_name: input.name, p_currency: input.currency, p_opening: input.openingBalance, p_receives_payments: input.receivesPayments, p_active: input.active ?? true });
}

export function saveFinanceMovement(input: { id: string | null; date: string; accountId: string; kind: FinKind; amount: number; category: string; description: string; partnerId: string | null; fromInvestment: boolean; direction?: "in" | "out" | null }) {
  return finRpc<string>("fin_save_movement", {
    p_id: input.id, p_date: input.date, p_account_id: input.accountId, p_kind: input.kind, p_amount: input.amount, p_category: input.category,
    p_description: input.description, p_partner_id: input.partnerId, p_from_investment: input.fromInvestment, p_direction: input.direction ?? null
  });
}

export function deleteFinanceMovement(id: string) {
  return finRpc<void>("fin_delete_movement", { p_id: id });
}

export function financeTransfer(input: { date: string; fromId: string; toId: string; amountFrom: number; amountTo: number; description: string }) {
  return finRpc<string>("fin_transfer", { p_date: input.date, p_from: input.fromId, p_to: input.toId, p_amount_from: input.amountFrom, p_amount_to: input.amountTo, p_description: input.description });
}

export function saveFinanceRecurring(input: { id: string | null; name: string; category: string; amount: number; accountId: string; dayOfMonth: number; fromInvestment: boolean; active?: boolean }) {
  return finRpc<string>("fin_save_recurring", { p_id: input.id, p_name: input.name, p_category: input.category, p_amount: input.amount, p_account_id: input.accountId, p_day: input.dayOfMonth, p_from_investment: input.fromInvestment, p_active: input.active ?? true });
}

export function deleteFinanceRecurring(id: string) {
  return finRpc<void>("fin_delete_recurring", { p_id: id });
}

export function saveFinancePartners(partners: FinPartner[]) {
  return finRpc<void>("fin_save_partners", { p_partners: partners });
}

export function importFinancePayments(from: string) {
  return finRpc<number>("fin_import_payments", { p_from: from });
}

/** Crea la cuenta de otro administrador de Patagonia (un socio) y devuelve su contraseña temporal. */
export async function addPlatformAdmin(email: string, fullName: string): Promise<{ email: string; tempPassword: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.functions.invoke("add-platform-admin", { body: { email, fullName } });
  if (error) {
    let message = error.message;
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        if (body?.error) message = body.error;
      } catch {
        // mensaje por defecto
      }
    }
    throw new Error(message);
  }
  if (!data || (data as { error?: string }).error) throw new Error((data as { error?: string })?.error ?? "No se pudo crear la cuenta.");
  return data as { email: string; tempPassword: string };
}

// ── Gasto de Meta en Finanzas (migración 159) ──────────────────────────────────

export interface MetaStatus {
  connected: boolean;
  adAccountId?: string;
  accountId?: string;
  fromInvestment?: boolean;
  lastSyncAt?: string | null;
  lastSyncUntil?: string | null;
  lastError?: string | null;
  tokenEnd?: string;
}

export function getMetaStatus() {
  return finRpc<MetaStatus>("fin_meta_status", {});
}

export function saveMetaSettings(input: { adAccountId: string; token: string | null; accountId: string; fromInvestment: boolean }) {
  return finRpc<void>("fin_meta_save", { p_ad_account_id: input.adAccountId, p_token: input.token, p_account_id: input.accountId, p_from_investment: input.fromInvestment });
}

export function disconnectMeta() {
  return finRpc<void>("fin_meta_disconnect", {});
}

/** Trae el gasto de Meta (solo lectura). Devuelve cuántos días de campaña anotó. */
export async function syncMetaAds(): Promise<{ connected: boolean; saved?: number; since?: string }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.functions.invoke("meta-ads-sync", { body: {} });
  if (error) {
    let message = error.message;
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        if (body?.error) message = body.error;
      } catch {
        // mensaje por defecto
      }
    }
    throw new Error(message);
  }
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  return data as { connected: boolean; saved?: number; since?: string };
}
