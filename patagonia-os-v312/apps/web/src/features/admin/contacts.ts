/** Pestaña "Contactos": la agenda de todos los que alguna vez escribieron
 * (platform_leads). Lógica pura, sin lib/supabase, para poder testearla. */

import { LEAD_MAX_ATTEMPTS, type Lead } from "./sales-pipeline";
import { phoneKey } from "./lead-import";

export type ContactFilter = "todos" | "contestaron" | "sin_respuesta" | "no" | "mes" | "clientes";

export const CONTACT_FILTERS: { id: ContactFilter; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "contestaron", label: "Contestaron" },
  { id: "sin_respuesta", label: "Sin respuesta" },
  { id: "no", label: "Dijeron que no / no contestaron más" },
  { id: "mes", label: "Sin hablar hace más de un mes" },
  { id: "clientes", label: "Ya son clientes" }
];

/** Días desde la última vez que se le escribió (o desde que se cargó). */
export function daysSinceTouch(lead: Lead, now: number = Date.now()): number {
  const iso = lead.lastContactedAt ?? lead.repliedAt ?? lead.createdAt;
  return Math.floor((now - new Date(iso).getTime()) / 86_400_000);
}

export interface ContactStatus {
  label: string;
  tone: "ok" | "soon" | "none" | "expired";
}

export function contactStatus(lead: Lead): ContactStatus {
  if (lead.stage === "alta") return { label: "Cliente", tone: "ok" };
  if (lead.stage === "perdido") return { label: !lead.lostReason ? "No" : /^no\s/i.test(lead.lostReason) ? lead.lostReason : `No: ${lead.lostReason}`, tone: "expired" };
  if (lead.repliedAt) return { label: lead.stage === "demo" ? "Vio la demo" : "Contestó", tone: "ok" };
  const n = Math.min(lead.attempts ?? 0, LEAD_MAX_ATTEMPTS);
  return { label: n === 0 ? "Sin escribirle todavía" : `Sin respuesta (${n} ${n === 1 ? "mensaje" : "mensajes"})`, tone: n >= 3 ? "soon" : "none" };
}

function normalize(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export function matchesContact(lead: Lead, filter: ContactFilter, query: string, now: number = Date.now()): boolean {
  switch (filter) {
    case "contestaron": if (!lead.repliedAt || lead.stage === "perdido" || lead.stage === "alta") return false; break;
    case "sin_respuesta": if (lead.repliedAt || lead.stage === "perdido" || lead.stage === "alta") return false; break;
    case "no": if (lead.stage !== "perdido") return false; break;
    case "mes": if (lead.stage === "alta" || daysSinceTouch(lead, now) < 30) return false; break;
    case "clientes": if (lead.stage !== "alta") return false; break;
  }
  const q = normalize(query);
  if (!q) return true;
  if ([lead.contactName, lead.businessName, lead.note, lead.source, lead.city, lead.province, lead.lostReason].some((v) => v && normalize(v).includes(q))) return true;
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 3 && lead.phone) {
    const key = phoneKey(lead.phone) ?? "";
    return lead.phone.replace(/\D/g, "").includes(digits) || key.includes(digits);
  }
  return false;
}

/** Nombre para mostrar: la persona, o el negocio, o "Sin nombre". */
export function contactName(lead: Lead): string {
  return lead.contactName || (lead.businessName !== "Sin nombre" ? lead.businessName : "") || "Sin nombre";
}
