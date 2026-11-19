// Kommo -> embudo de interesados por sincronización periódica (migración 206), para
// cuentas de Kommo sin webhooks (plan Base). La base la llama cada 5 minutos con
// el encabezado x-kommo-sync-token (= kommo_sync_schedule.token).
//
// Lee la API v4 de Kommo con el token de una integración privada:
// * /contacts con created_at desde el cursor -> kommo_lead_event(incoming = false)
// * /events tipo incoming_chat_message desde el cursor -> kommo_lead_event(incoming = true)
//   (la API común no trae el texto del mensaje, solo quién escribió y cuándo).
// La primera corrida con token solo pone los cursores en "ahora": no trae la historia.
//
// Secretos: KOMMO_TOKEN (token de larga duración) y KOMMO_SUBDOMAIN (el de
// <subdominio>.kommo.com). Sin ellos no hace nada. Deploy con --no-verify-jwt.

import { createClient } from "npm:@supabase/supabase-js@2";
import { phoneFromApiContact, sameKey } from "../kommo-webhook/kommo.ts";
import {
  contactsCursor,
  eventContact,
  eventsCursor,
  mainContactOfLead,
  newEvents,
  type KommoApiContact,
  type KommoEvent
} from "./sync.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = (Deno.env.get("KOMMO_TOKEN") ?? "").trim();
const SUBDOMAIN = (Deno.env.get("KOMMO_SUBDOMAIN") ?? "").trim().toLowerCase().replace(/\.kommo\.com.*$/, "").replace(/^https?:\/\//, "");
const MAX_PAGES = 10;

// deno-lint-ignore no-explicit-any
type Json = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Kommo permite unas 7 consultas por segundo por cuenta: se va de a una con una pausa.
async function kommoGet(path: string): Promise<Json | null> {
  await sleep(200);
  const res = await fetch(`https://${SUBDOMAIN}.kommo.com/api/v4${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(15000)
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error(`Kommo rechazó el token (${res.status}): revisá KOMMO_TOKEN (¿venció?) y KOMMO_SUBDOMAIN.`);
  if (!res.ok) throw new Error(`Kommo respondió ${res.status} en ${path.split("?")[0]}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function listAll<T>(path: string, key: string): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await kommoGet(`${path}&page=${page}`);
    const chunk: T[] = body?._embedded?.[key] ?? [];
    items.push(...chunk);
    if (!body?._links?.next || chunk.length === 0) return { items, truncated: false };
  }
  return { items, truncated: true };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: schedule, error: schedErr } = await admin.from("kommo_sync_schedule").select("*").eq("id", 1).maybeSingle();
  if (schedErr || !schedule) return new Response("Falta la migración 206", { status: 500 });
  if (!sameKey(req.headers.get("x-kommo-sync-token") ?? "", schedule.token)) return new Response("No autorizado", { status: 401 });

  const save = (patch: Record<string, unknown>, result: Record<string, unknown>) =>
    admin.from("kommo_sync_schedule").update({ ...patch, last_run_at: new Date().toISOString(), last_result: result }).eq("id", 1);

  if (!TOKEN || !SUBDOMAIN) {
    await save({}, { skipped: "Faltan los secretos KOMMO_TOKEN y KOMMO_SUBDOMAIN" });
    return Response.json({ skipped: true });
  }

  const now = Math.floor(Date.now() / 1000);
  if (schedule.contacts_since == null || schedule.events_since == null) {
    await save({ contacts_since: now, events_since: now, events_seen: [] }, { started: true });
    return Response.json({ started: true });
  }

  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const notes: string[] = [];
  try {
    // 1) Contactos nuevos.
    const contacts = await listAll<KommoApiContact>(
      `/contacts?filter[created_at][from]=${schedule.contacts_since}&order[id]=asc&limit=250`,
      "contacts"
    );
    for (const c of contacts.items) {
      const { data, error } = await admin.rpc("kommo_lead_event", {
        p_contact_id: c.id,
        p_name: c.name?.trim() || null,
        p_phone: phoneFromApiContact(c),
        p_incoming: false,
        p_text: null
      });
      bump(error ? "error" : String(data));
      if (error) notes.push(`contacto ${c.id}: ${error.message}`);
    }
    if (contacts.truncated) notes.push(`más de ${MAX_PAGES * 250} contactos nuevos: el resto en la próxima`);

    // 2) Mensajes entrantes.
    const raw = await listAll<KommoEvent>(
      `/events?filter[type]=incoming_chat_message&filter[created_at][from]=${schedule.events_since}&limit=100`,
      "events"
    );
    const seen: string[] = Array.isArray(schedule.events_seen) ? schedule.events_seen : [];
    const events = newEvents(raw.items, schedule.events_since, seen);
    const cache = new Map<number, { name: string | null; phone: string | null }>();
    for (const ev of events) {
      const ref = eventContact(ev);
      let contactId: number | null = null;
      if (ref && "contactId" in ref) contactId = ref.contactId;
      else if (ref && "leadId" in ref) contactId = mainContactOfLead(await kommoGet(`/leads/${ref.leadId}?with=contacts`));
      if (contactId == null) {
        bump("sin contacto");
        continue;
      }
      if (!cache.has(contactId)) {
        const c = await kommoGet(`/contacts/${contactId}`);
        cache.set(contactId, { name: typeof c?.name === "string" && c.name.trim() ? c.name.trim() : null, phone: phoneFromApiContact(c) });
      }
      const info = cache.get(contactId)!;
      const { data, error } = await admin.rpc("kommo_lead_event", {
        p_contact_id: contactId,
        p_name: info.name,
        p_phone: info.phone,
        p_incoming: true,
        p_text: null
      });
      bump(error ? "error" : String(data));
      if (error) notes.push(`mensaje ${ev.id}: ${error.message}`);
    }
    if (raw.truncated) notes.push(`más de ${MAX_PAGES * 100} mensajes en 5 minutos: pudieron quedar algunos sin leer`);

    const ec = eventsCursor(events, schedule.events_since, seen);
    await save(
      { contacts_since: contactsCursor(contacts.items, schedule.contacts_since), events_since: ec.since, events_seen: ec.seen },
      { contacts: contacts.items.length, messages: events.length, ...counts, ...(notes.length ? { notes } : {}) }
    );
    return Response.json({ ok: true, ...counts });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await save({}, { error: msg, ...counts });
    return Response.json({ error: msg }, { status: 200 });
  }
});
