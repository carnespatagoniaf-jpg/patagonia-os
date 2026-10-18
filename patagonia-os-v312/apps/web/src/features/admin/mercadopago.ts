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

/** Propone de qué cliente es una suscripción: mismo email del dueño, o mismo
 * nombre y apellido. null si no hay una sola coincidencia clara. */
export function suggestCompany(sub: Pick<MpSubscription, "payerEmail" | "payerName">, companies: MpCompanyLike[]): string | null {
  if (sub.payerEmail) {
    const email = normalize(sub.payerEmail);
    const byEmail = companies.filter((c) => c.ownerEmail && normalize(c.ownerEmail) === email);
    if (byEmail.length === 1) return byEmail[0].id;
  }
  if (sub.payerName) {
    const words = normalize(sub.payerName).split(/\s+/).filter((w) => w.length >= 3);
    if (words.length >= 2) {
      const byName = companies.filter((c) => {
        const owner = c.ownerFullName ? normalize(c.ownerFullName) : "";
        return words.every((w) => owner.includes(w));
      });
      if (byName.length === 1) return byName[0].id;
    }
  }
  return null;
}

function firstName(fullName: string | null | undefined) {
  return fullName?.trim().split(/\s+/)[0] ?? "";
}

/** Mensaje de WhatsApp cuando no pasó el cobro de la suscripción. */
export function mpFailedChargeMessage(companyName: string, ownerFullName: string | null | undefined): string {
  const name = firstName(ownerFullName);
  return `¡Hola${name ? ` ${name}` : ""}! Te escribo de Patagonia OS. Mercado Pago no pudo cobrar este mes la suscripción de ${companyName}, capaz la tarjeta venció o no tenía saldo. ¿Podés revisarla en tu Mercado Pago (Suscripciones)? ¡Gracias!`;
}
