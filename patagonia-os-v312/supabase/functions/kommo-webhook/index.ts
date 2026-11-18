// Kommo -> embudo de interesados (migración 205). Kommo llama a esta función cada vez
// que entra un contacto nuevo o llega un mensaje (WhatsApp, Instagram...), y el
// contacto queda en platform_leads (pestaña "Ventas" del panel de plataforma).
//
// Configuración (secretos de la función):
//   KOMMO_WEBHOOK_KEY  clave larga al azar; va en la URL del webhook: …/kommo-webhook?key=<clave>
//   KOMMO_SUBDOMAIN    el de <subdominio>.kommo.com (opcional: si está, se rechazan avisos de otra cuenta)
//   KOMMO_TOKEN        token de larga duración de una integración privada de Kommo (opcional,
//                      pero sin él no se sabe el teléfono de quien escribe si no estaba cargado)
// Sin JWT (Kommo no lo manda): deploy con --no-verify-jwt.
//
// Siempre responde 200 rápido: Kommo apaga el webhook si falla o tarda. Lo que llegó y
// qué se hizo queda en kommo_webhook_events.

import { createClient } from "npm:@supabase/supabase-js@2";
import { kommoLeadEvents, kommoSubdomain, parseKommoForm, phoneFromApiContact, sameKey, type KommoLeadEvent } from "./kommo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_KEY = Deno.env.get("KOMMO_WEBHOOK_KEY") ?? "";
const SUBDOMAIN = (Deno.env.get("KOMMO_SUBDOMAIN") ?? "").trim().toLowerCase();
const TOKEN = Deno.env.get("KOMMO_TOKEN") ?? "";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

async function fetchContact(contactId: number): Promise<{ name: string | null; phone: string | null } | null> {
  if (!TOKEN || !SUBDOMAIN) return null;
  try {
    const res = await fetch(`https://${SUBDOMAIN}.kommo.com/api/v4/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const body = await res.json();
    return { name: typeof body?.name === "string" && body.name.trim() ? body.name.trim() : null, phone: phoneFromApiContact(body) };
  } catch {
    return null;
  }
}

async function handle(payload: Record<string, unknown>, events: KommoLeadEvent[]) {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const results: string[] = [];
  for (const ev of events) {
    let { name, phone } = ev;
    if (!phone) {
      const contact = await fetchContact(ev.contactId);
      if (contact) {
        phone = contact.phone;
        name = contact.name ?? name;
      }
    }
    const { data, error } = await admin.rpc("kommo_lead_event", {
      p_contact_id: ev.contactId,
      p_name: name,
      p_phone: phone,
      p_incoming: ev.incoming,
      p_text: ev.text
    });
    results.push(`${ev.contactId}: ${error ? `error ${error.message}` : data}`);
  }
  await admin.from("kommo_webhook_events").insert({ payload, result: results.join("; ") || "sin datos útiles" });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const url = new URL(req.url);
  if (!WEBHOOK_KEY || !sameKey(url.searchParams.get("key") ?? "", WEBHOOK_KEY)) {
    return new Response("No autorizado", { status: 401 });
  }

  const raw = await req.text();
  let payload: Record<string, unknown>;
  let events: KommoLeadEvent[] = [];
  try {
    const parsed = parseKommoForm(raw);
    const sub = kommoSubdomain(parsed);
    if (SUBDOMAIN && sub && sub.toLowerCase() !== SUBDOMAIN) {
      return new Response("Otra cuenta", { status: 403 });
    }
    payload = parsed;
    events = kommoLeadEvents(parsed);
  } catch {
    payload = { raw: raw.slice(0, 5000) };
  }

  const work = handle(payload, events).catch((e) => console.error("kommo-webhook", e));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  else await work;
  return new Response("ok");
});
