// Lógica pura de kommo-sync (sin Deno ni Supabase), probada desde
// apps/web/src/features/admin/kommo-sync.test.ts.

export interface KommoEvent {
  id: string;
  type: string;
  entity_id: number;
  entity_type: string;
  created_at: number;
}

export interface KommoApiContact {
  id: number;
  name?: string | null;
  created_at: number;
  custom_fields_values?: unknown;
}

/**
 * Eventos que todavía no se procesaron: desde `since` (inclusive, en segundos
 * como los da Kommo) sin los ids ya vistos en ese mismo segundo. Ordenados del
 * más viejo al más nuevo.
 */
export function newEvents(events: KommoEvent[], since: number, seen: string[]): KommoEvent[] {
  const seenSet = new Set(seen);
  return events
    .filter((e) => e.created_at >= since && !seenSet.has(String(e.id)))
    .sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)));
}

/**
 * Nuevo cursor de eventos: el segundo del último evento procesado y los ids de
 * ese segundo (para no repetirlos en la próxima consulta, que lo incluye).
 */
export function eventsCursor(processed: KommoEvent[], since: number, seen: string[]): { since: number; seen: string[] } {
  if (processed.length === 0) return { since, seen };
  const last = Math.max(...processed.map((e) => e.created_at));
  const ids = processed.filter((e) => e.created_at === last).map((e) => String(e.id));
  const keep = last === since ? seen : [];
  return { since: last, seen: [...new Set([...keep, ...ids])] };
}

/** Nuevo cursor de contactos: el created_at más alto visto (la próxima consulta lo incluye; repetir es inofensivo). */
export function contactsCursor(contacts: KommoApiContact[], since: number): number {
  return contacts.reduce((max, c) => Math.max(max, Number(c.created_at) || 0), since);
}

/** Contacto (id) al que pertenece un evento de mensaje: directo si es de contacto; si es de un lead, hay que buscarlo. */
export function eventContact(e: KommoEvent): { contactId: number } | { leadId: number } | null {
  if (!Number.isFinite(e.entity_id) || e.entity_id <= 0) return null;
  if (e.entity_type === "contact") return { contactId: e.entity_id };
  if (e.entity_type === "lead") return { leadId: e.entity_id };
  return null;
}

/** Contacto principal de un lead leído con ?with=contacts. */
export function mainContactOfLead(lead: unknown): number | null {
  const contacts = (lead as { _embedded?: { contacts?: { id?: number; is_main?: boolean }[] } })?._embedded?.contacts;
  if (!Array.isArray(contacts) || contacts.length === 0) return null;
  const main = contacts.find((c) => c?.is_main) ?? contacts[0];
  return typeof main?.id === "number" ? main.id : null;
}
