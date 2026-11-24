/** Suscripciones de Mercado Pago en el panel de plataforma (migración 129).
 * Lógica pura, sin lib/supabase, para poder testearla. */

import { formatDayMonth } from "./company-billing";

export interface MpSubscription {
  id: string;
  companyId: string | null;
  companyName: string | null;
  status: string | null;
  reason: string | null;
  payerName: string | null;
  payerEmail: string | null;
  amount: number | null;
  dateCreated: string | null;
  nextPaymentDate: string | null;
  lastChargeDate: string | null;
  lastChargeStatus: string | null;
  lastPaymentStatus: string | null;
  lastPaymentStatusDetail: string | null;
  lastRetryAttempt: number | null;
  approvedCount: number;
  syncedAt: string | null;
}

export interface MpCompanyLike {
  id: string;
  name: string;
  ownerFullName?: string | null;
  ownerEmail?: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  authorized: "Activa",
  paused: "Pausada",
  cancelled: "Cancelada",
  pending: "Sin terminar de pagar"
};

export function mpStatusLabel(status: string | null): string {
  return (status && STATUS_LABELS[status]) || status || "Desconocida";
}

/** Texto del problema de cobro, o null si la suscripción está al día. */
export function mpProblem(sub: MpSubscription): string | null {
  if (sub.status === "cancelled") return "Canceló la suscripción";
  if (sub.status === "paused") return "Pausó la suscripción";
  const failed =
    sub.lastChargeStatus === "recycling" ||
    sub.lastPaymentStatus === "rejected" ||
    sub.lastPaymentStatus === "cancelled";
  if (!failed) return null;
  const when = sub.lastChargeDate ? ` del ${formatDayMonth(toArDate(sub.lastChargeDate))}` : "";
  const retry = sub.lastChargeStatus === "recycling" && sub.lastRetryAttempt ? ` (Mercado Pago lo reintenta, intento ${sub.lastRetryAttempt})` : "";
  return `No pasó el cobro${when}${retry}`;
}

/** Fecha (YYYY-MM-DD) en hora de Argentina de un timestamp ISO. */
export function toArDate(iso: string): string {
  return new Date(new Date(iso).getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

function normalize(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Palabras que no sirven para reconocer un negocio (rubro, sociedad, conectores). */
const GENERIC_WORDS = new Set([
  "de", "del", "la", "las", "el", "los", "y", "e", "en", "sa", "srl", "sas", "sociedad", "por", "acciones", "aciones", "simplificada", "sim",
  "carniceria", "carnes", "carne", "polleria", "pollos", "granja", "fiambreria", "almacen", "supermercado", "super", "autoservicio",
  "mayorista", "distribuidora", "frigorifico", "comercial", "local", "sucursal"
]);

function words(text: string | null | undefined, minLength = 3): string[] {
  if (!text) return [];
  return normalize(text).replace(/[^a-z0-9ñ]+/g, " ").split(/\s+/).filter((w) => w.length >= minLength);
}

function significantWords(text: string | null | undefined): string[] {
  return words(text, 3).filter((w) => !GENERIC_WORDS.has(w));
}

function contains(haystack: string[], needles: string[]) {
  return needles.length > 0 && needles.every((n) => haystack.includes(n));
}

export interface MpSuggestion {
  companyId: string;
  /** Por qué se propone, para mostrarlo al lado ("mismo mail", "nombre del negocio"…). */
  why: string;
}

/**
 * Propone de qué cliente es una suscripción. Se prueba en este orden y gana el primer criterio que da UN solo
 * cliente (si da varios, no se propone nada para no equivocarse):
 * 1. mismo mail que el dueño;
 * 2. mismo nombre y apellido del dueño, en cualquier orden y aunque uno tenga un segundo nombre;
 * 3. nombre del negocio (sin "carnicería", "S.A.", etc.), porque varios pagan a nombre del negocio;
 * 4. mismo usuario de mail (lo de antes de la @), para los que pagan con otro mail del mismo nombre.
 */
export function suggestMatch(sub: Pick<MpSubscription, "payerEmail" | "payerName">, companies: MpCompanyLike[]): MpSuggestion | null {
  const email = sub.payerEmail ? normalize(sub.payerEmail) : "";
  const payer = words(sub.payerName);
  const payerAll = [...payer, ...words(email.split("@")[0])];
  const tiers: Array<[string, (c: MpCompanyLike) => boolean]> = [
    ["mismo mail del dueño", (c) => Boolean(email && c.ownerEmail && normalize(c.ownerEmail) === email)],
    [
      "mismo nombre del dueño",
      (c) => {
        const owner = words(c.ownerFullName);
        return (payer.length >= 2 && contains(owner, payer)) || (owner.length >= 2 && contains(payer, owner));
      }
    ],
    [
      "nombre del negocio",
      (c) => {
        const business = significantWords(c.name);
        const payerBiz = significantWords(sub.payerName);
        return (business.length > 0 && business.some((w) => w.length >= 4) && contains(payerAll, business)) || (payerBiz.length >= 2 && payerBiz.some((w) => w.length >= 4) && contains(significantWords(c.name), payerBiz));
      }
    ],
    [
      "mail parecido al del dueño",
      (c) => {
        const user = email.split("@")[0];
        return Boolean(user && user.length >= 5 && c.ownerEmail && normalize(c.ownerEmail).split("@")[0] === user);
      }
    ]
  ];
  for (const [why, test] of tiers) {
    const found = companies.filter(test);
    if (found.length === 1) return { companyId: found[0].id, why };
    if (found.length > 1) return null;
  }
  return null;
}

/** Igual que suggestMatch, solo el cliente. */
export function suggestCompany(sub: Pick<MpSubscription, "payerEmail" | "payerName">, companies: MpCompanyLike[]): string | null {
  return suggestMatch(sub, companies)?.companyId ?? null;
}

function firstName(fullName: string | null | undefined) {
  return fullName?.trim().split(/\s+/)[0] ?? "";
}

/** Mensaje de WhatsApp cuando no pasó el cobro de la suscripción. */
export function mpFailedChargeMessage(companyName: string, ownerFullName: string | null | undefined): string {
  const name = firstName(ownerFullName);
  return `¡Hola${name ? ` ${name}` : ""}! Te escribo de Patagonia OS. Mercado Pago no pudo cobrar este mes la suscripción de ${companyName}, capaz la tarjeta venció o no tenía saldo. ¿Podés revisarla en tu Mercado Pago (Suscripciones)? ¡Gracias!`;
}
