/** Embudo de ventas del panel de plataforma (migración 116). Lógica pura, sin
 * lib/supabase, para poder testearla: etapa de cada cliente según su uso real
 * y "a quién escribirle hoy" con el mensaje de WhatsApp listo. */

export type LeadStage = "contacto" | "demo" | "alta" | "perdido";

/** Etapas del tablero. Las de clientes salen solas del uso real. */
export type PipelineStage = "contacto" | "demo" | "sin_arrancar" | "cargando" | "usando" | "pago" | "perdido";

export const PIPELINE_STAGES: { id: PipelineStage; label: string; hint: string }[] = [
  { id: "contacto", label: "Contacto", hint: "Preguntó. Todavía no vio la demo." },
  { id: "demo", label: "Demo", hint: "Vio la demo. Falta darle el alta." },
  { id: "sin_arrancar", label: "Prueba sin arrancar", hint: "Tiene cuenta pero no cargó productos." },
  { id: "cargando", label: "Cargó productos", hint: "Tiene productos pero todavía no vendió." },
  { id: "usando", label: "Usando", hint: "Ya vende con el sistema. Falta que pague." },
  { id: "pago", label: "Pagó", hint: "Cliente que paga." },
  { id: "perdido", label: "Perdido", hint: "No siguió." }
];

export interface CompanyUsage {
  productCount: number;
  saleCount: number;
  salesLast7d: number;
  firstSaleAt: string | null;
  lastSaleAt: string | null;
  closedShiftCount: number;
  purchaseCount: number;
  lastSignInAt: string | null;
  salesNote: string | null;
  salesContactedAt: string | null;
  salesLostReason: string | null;
}

export interface PipelineCompany {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  ownerFullName: string | null;
  contactPhone: string | null;
  trialEndsAt: string | null;
  /** YYYY-MM-DD */
  paidUntil: string | null;
  usage: CompanyUsage | null;
}

export interface Lead {
  id: string;
  businessName: string;
  contactName: string | null;
  phone: string | null;
  province: string | null;
  city: string | null;
  stage: LeadStage;
  source: string | null;
  note: string | null;
  /** YYYY-MM-DD */
  nextContactOn: string | null;
  lostReason: string | null;
  companyId: string | null;
  createdAt: string;
}

const DAY_MS = 86_400_000;
/** Si se le escribió hace menos que esto, no vuelve a aparecer en "escribile hoy". */
export const CONTACT_COOLDOWN_DAYS = 2;
/** Un cliente que paga y no vende hace estos días aparece como "dejó de usarlo". */
export const IDLE_PAID_DAYS = 7;
/** Días antes del vencimiento del abono en que se avisa. */
export const PAYMENT_REMINDER_DAYS = 3;

export function companyStage(company: PipelineCompany, todayIso: string): PipelineStage {
  if (!company.active || company.usage?.salesLostReason) return "perdido";
  if (company.paidUntil && company.paidUntil >= todayIso) return "pago";
  const usage = company.usage;
  if (!usage || usage.productCount === 0) return "sin_arrancar";
  if (usage.saleCount === 0) return "cargando";
  return "usando";
}

function daysSince(iso: string, now: number) {
  return Math.floor((now - new Date(iso).getTime()) / DAY_MS);
}

function firstName(full: string | null) {
  const name = (full ?? "").trim().split(/\s+/)[0];
  return name ? ` ${name}` : "";
}

export type FollowUpKind =
  | "lead_due"
  | "no_products"
  | "no_sales"
  | "trial_ending"
  | "trial_expired"
  | "paid_idle"
  | "payment_due";

export interface FollowUp {
  kind: FollowUpKind;
  /** Para ordenar: menor = más urgente. */
  priority: number;
  title: string;
  reason: string;
  message: string;
  phone: string | null;
  companyId?: string;
  leadId?: string;
  name: string;
}

const PRIORITY: Record<FollowUpKind, number> = {
  trial_ending: 0,
  payment_due: 1,
  no_products: 2,
  no_sales: 3,
  paid_idle: 4,
  trial_expired: 5,
  lead_due: 6
};

/** Mensajes de WhatsApp: cortos, en el tono del dueño, sin palabras técnicas. */
export function followUpMessage(kind: FollowUpKind, name: string | null, business: string): string {
  const hi = `¡Hola${firstName(name)}!`;
  switch (kind) {
    case "no_products":
      return `${hi} Soy de Patagonia System. Vi que todavía no cargaste los productos de ${business}. Si me mandás tu lista de precios (foto, Excel o como la tengas) te la cargo yo hoy y mañana ya podés vender con el sistema. ¿Te parece?`;
    case "no_sales":
      return `${hi} Ya tenés los productos cargados en Patagonia System 👏 ¿Probaste hacer una venta desde Mostrador? Si querés te muestro en 5 minutos por videollamada cómo cobrar y cerrar la caja.`;
    case "trial_ending":
      return `${hi} Tu prueba de Patagonia System para ${business} termina en estos días. Para seguir usándolo sin perder nada de lo que cargaste, te paso los planes: Básico $20.000, Estándar $39.000 y Full $69.000 por mes. ¿Cuál te sirve más?`;
    case "trial_expired":
      return `${hi} Tu prueba de Patagonia System terminó. Todo lo que cargaste sigue guardado. ¿Querés que te extienda unos días más para probarlo con tranquilidad, o lo dejamos acá? Cualquier respuesta me sirve.`;
    case "paid_idle":
      return `${hi} Vi que hace unos días no se registran ventas en Patagonia System para ${business}. ¿Está todo bien? ¿Te puedo ayudar con algo?`;
    case "payment_due":
      return `${hi} Te recuerdo que en estos días vence el abono de Patagonia System para ${business}. Cuando lo pagues avisame y lo registro. ¡Gracias!`;
    case "lead_due":
      return `${hi} Soy de Patagonia System. ¿Pudiste ver lo que te mandé? Si querés te muestro el sistema en 15 minutos con una carnicería de ejemplo y te dejo 7 días gratis para probarlo.`;
  }
}

const TITLES: Record<FollowUpKind, string> = {
  no_products: "No cargó productos",
  no_sales: "Cargó productos pero no vendió",
  trial_ending: "Termina la prueba: ofrecer plan",
  trial_expired: "Prueba vencida sin pago",
  paid_idle: "Pagó pero dejó de usarlo",
  payment_due: "Vence el abono",
  lead_due: "Seguimiento de interesado"
};

function make(kind: FollowUpKind, reason: string, base: { name: string; owner: string | null; phone: string | null; companyId?: string; leadId?: string }): FollowUp {
  return {
    kind,
    priority: PRIORITY[kind],
    title: TITLES[kind],
    reason,
    message: followUpMessage(kind, base.owner, base.name),
    phone: base.phone,
    companyId: base.companyId,
    leadId: base.leadId,
    name: base.name
  };
}

/** Qué hacer hoy con un cliente, o null si no hace falta escribirle. */
export function companyFollowUp(company: PipelineCompany, todayIso: string, now: number = Date.now()): FollowUp | null {
  if (!company.active) return null;
  const usage = company.usage;
  if (usage?.salesLostReason) return null;
  if (usage?.salesContactedAt && daysSince(usage.salesContactedAt, now) < CONTACT_COOLDOWN_DAYS) return null;

  const base = { name: company.name, owner: company.ownerFullName, phone: company.contactPhone, companyId: company.id };
  const ageDays = daysSince(company.createdAt, now);

  if (company.paidUntil && company.paidUntil >= todayIso) {
    const left = Math.round((Date.parse(`${company.paidUntil}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / DAY_MS);
    if (left <= PAYMENT_REMINDER_DAYS) return make("payment_due", left === 0 ? "Vence hoy." : `Vence en ${left} ${left === 1 ? "día" : "días"}.`, base);
    const idle = usage?.lastSaleAt ? daysSince(usage.lastSaleAt, now) : null;
    if (idle !== null && idle >= IDLE_PAID_DAYS) return make("paid_idle", `No vende hace ${idle} días.`, base);
    return null;
  }

  const trialLeft = company.trialEndsAt ? Math.ceil((new Date(company.trialEndsAt).getTime() - now) / DAY_MS) : null;
  const products = usage?.productCount ?? 0;
  const sales = usage?.saleCount ?? 0;

  if (trialLeft !== null && trialLeft <= 0) {
    return make("trial_expired", `La prueba venció${sales > 0 ? ` y llegó a hacer ${sales} ventas` : products > 0 ? " (cargó productos, nunca vendió)" : " sin cargar nada"}.`, base);
  }
  if (sales > 0 && trialLeft !== null && trialLeft <= 2) {
    return make("trial_ending", `Le quedan ${trialLeft} ${trialLeft === 1 ? "día" : "días"} y ya hizo ${sales} ventas.`, base);
  }
  if (products === 0 && ageDays >= 1) {
    return make("no_products", `Alta hace ${ageDays} ${ageDays === 1 ? "día" : "días"} y 0 productos.`, base);
  }
  if (products > 0 && sales === 0 && ageDays >= 2) {
    return make("no_sales", `${products} productos cargados, ninguna venta.`, base);
  }
  if (trialLeft !== null && trialLeft <= 2) {
    return make("trial_ending", `Le quedan ${trialLeft} ${trialLeft === 1 ? "día" : "días"} de prueba.`, base);
  }
  return null;
}

export function leadFollowUp(lead: Lead, todayIso: string): FollowUp | null {
  if (lead.stage === "alta" || lead.stage === "perdido") return null;
  if (!lead.nextContactOn || lead.nextContactOn > todayIso) return null;
  const late = Math.round((Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${lead.nextContactOn}T00:00:00Z`)) / DAY_MS);
  return make("lead_due", late === 0 ? "Quedaste en escribirle hoy." : `Quedaste en escribirle hace ${late} ${late === 1 ? "día" : "días"}.`, {
    name: lead.businessName,
    owner: lead.contactName,
    phone: lead.phone,
    leadId: lead.id
  });
}

export function followUpsForToday(companies: PipelineCompany[], leads: Lead[], todayIso: string, now: number = Date.now()): FollowUp[] {
  const list: FollowUp[] = [];
  for (const c of companies) {
    const f = companyFollowUp(c, todayIso, now);
    if (f) list.push(f);
  }
  for (const l of leads) {
    const f = leadFollowUp(l, todayIso);
    if (f) list.push(f);
  }
  return list.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "es"));
}

/** Link de WhatsApp con el mensaje escrito. Argentina: agrega 549 si falta. */
export function whatsappLink(phone: string | null, message: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (!digits.startsWith("54")) {
    // Celular argentino escrito con el 15 después de la característica: 11 15 5555 5555 -> 11 5555 5555.
    if (digits.length === 12) digits = digits.replace(/^(\d{2,4})15(\d{6,8})$/, "$1$2");
    digits = `549${digits}`;
  } else if (!digits.startsWith("549")) {
    digits = `549${digits.slice(2)}`;
  }
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/** Conversión del embudo, de altas a pagos (solo clientes de los últimos N días si se pasa `sinceIso`). */
export interface FunnelCounts {
  altas: number;
  cargaron: number;
  vendieron: number;
  pagaron: number;
}

export function funnelCounts(companies: PipelineCompany[], sinceIso?: string): FunnelCounts {
  const list = sinceIso ? companies.filter((c) => c.createdAt >= sinceIso) : companies;
  return {
    altas: list.length,
    cargaron: list.filter((c) => (c.usage?.productCount ?? 0) > 0).length,
    vendieron: list.filter((c) => (c.usage?.saleCount ?? 0) > 0).length,
    pagaron: list.filter((c) => !!c.paidUntil).length
  };
}
