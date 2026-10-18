// Trae de Mercado Pago las suscripciones del abono y sus cobros, y los guarda
// en mp_subscriptions / mp_subscription_charges (migración 129). Después aplica
// los cobros aprobados de las suscripciones ya asignadas a un cliente
// (mp_apply_charges), que mueven companies.paid_until.
//
// Por qué "traer" y no un webhook: todos los clientes se suscriben al mismo
// link (plan de suscripción armado en el panel de Mercado Pago), y para
// suscripciones Mercado Pago no ofrece configurar las notificaciones desde
// "Tus integraciones". El panel de administrador llama a esta función al abrirse
// y con el botón "Actualizar".
//
// Solo platform admins. Secreto: MP_ACCESS_TOKEN (Access Token de producción de
// la cuenta de Mercado Pago del dueño; lo carga él en Supabase → Edge Functions
// → Secrets). Nunca llega al navegador.
//
// Deploy: npx supabase functions deploy mp-sync --project-ref <ref>

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MP_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const MP_API = "https://api.mercadopago.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// deno-lint-ignore no-explicit-any
type Json = any;

async function mpGet(path: string): Promise<Json> {
  const res = await fetch(`${MP_API}${path}`, { headers: { Authorization: `Bearer ${MP_TOKEN}` } });
  const text = await res.text();
  if (!res.ok) {
    const detail = text.slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new Error(`Mercado Pago rechazó el token (${res.status}). Revisá que sea el Access Token de producción. ${detail}`);
    throw new Error(`Mercado Pago respondió ${res.status} en ${path.split("?")[0]}: ${detail}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Recorre todas las páginas de un /search de Mercado Pago. */
async function mpSearchAll(path: string, max = 2000): Promise<Json[]> {
  const out: Json[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let offset = 0; offset < max; ) {
    const page = await mpGet(`${path}${sep}limit=100&offset=${offset}`);
    const results: Json[] = Array.isArray(page?.results) ? page.results : [];
    out.push(...results);
    const total = Number(page?.paging?.total ?? 0);
    offset += results.length;
    if (results.length === 0 || offset >= total) break;
  }
  return out;
}

/** Mercado Pago a veces manda fechas como texto ISO y a veces como número. */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(n) ? null : n;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método no permitido" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Falta autenticación");
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: callerAuth, error: callerAuthErr } = await callerClient.auth.getUser();
    if (callerAuthErr || !callerAuth.user) throw new Error("Usuario no autenticado");

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: isPlatformAdmin, error: adminCheckErr } = await admin
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", callerAuth.user.id)
      .maybeSingle();
    if (adminCheckErr || !isPlatformAdmin) throw new Error("No autorizado");

    if (!MP_TOKEN) return jsonResponse({ connected: false });

    const { data: known } = await admin.from("mp_subscriptions").select("id, payer_email");
    const knownEmail = new Map<string, string | null>((known ?? []).map((r: Json) => [r.id, r.payer_email]));

    const subscriptions = await mpSearchAll("/preapproval/search");
    let chargeCount = 0;
    const now = new Date().toISOString();

    for (const sub of subscriptions) {
      if (!sub?.id) continue;
      const charges = await mpSearchAll(`/authorized_payments/search?preapproval_id=${encodeURIComponent(sub.id)}`, 500);

      // El email del que paga casi nunca viene en la suscripción; se busca una
      // sola vez en el primer pago (sirve para reconocer de qué carnicería es).
      let payerEmail: string | null = sub.payer_email || knownEmail.get(sub.id) || null;
      let payerName = [sub.payer_first_name, sub.payer_last_name].filter(Boolean).join(" ").trim() || null;
      if (!payerEmail) {
        const withPayment = charges.find((c) => c?.payment?.id);
        if (withPayment) {
          try {
            const payment = await mpGet(`/v1/payments/${encodeURIComponent(withPayment.payment.id)}`);
            payerEmail = payment?.payer?.email || null;
            if (!payerName) payerName = payment?.card?.cardholder?.name || null;
          } catch {
            // Sin email no pasa nada: se asigna a mano por nombre o monto.
          }
        }
      }

      const { error: subErr } = await admin.from("mp_subscriptions").upsert(
        {
          id: String(sub.id),
          status: sub.status ?? null,
          reason: sub.reason ?? null,
          payer_id: toNumber(sub.payer_id),
          payer_name: payerName,
          payer_email: payerEmail,
          amount: toNumber(sub.auto_recurring?.transaction_amount),
          frequency: toNumber(sub.auto_recurring?.frequency),
          frequency_type: sub.auto_recurring?.frequency_type ?? null,
          date_created: toIso(sub.date_created),
          next_payment_date: toIso(sub.next_payment_date),
          last_charged_date: toIso(sub.summarized?.last_charged_date),
          raw: sub,
          synced_at: now
        },
        { onConflict: "id" }
      );
      if (subErr) throw new Error(`No se pudo guardar la suscripción: ${subErr.message}`);

      const rows = charges
        .filter((c) => c?.id)
        .map((c) => ({
          id: String(c.id),
          preapproval_id: String(sub.id),
          status: c.status ?? null,
          payment_id: c.payment?.id ? String(c.payment.id) : null,
          payment_status: c.payment?.status ?? null,
          payment_status_detail: c.payment?.status_detail ?? null,
          amount: toNumber(c.transaction_amount),
          debit_date: toIso(c.debit_date),
          date_created: toIso(c.date_created),
          retry_attempt: toNumber(c.retry_attempt),
          raw: c,
          synced_at: now
        }));
      if (rows.length > 0) {
        // upsert sin tocar company_payment_id ni skipped (no vienen en el objeto).
        const { error: chErr } = await admin.from("mp_subscription_charges").upsert(rows, { onConflict: "id" });
        if (chErr) throw new Error(`No se pudieron guardar los cobros: ${chErr.message}`);
        chargeCount += rows.length;
      }
    }

    const { data: assigned } = await admin.from("mp_subscriptions").select("company_id").not("company_id", "is", null);
    const companyIds = [...new Set((assigned ?? []).map((r: Json) => r.company_id as string))];
    let applied = 0;
    for (const companyId of companyIds) {
      const { data, error } = await admin.rpc("mp_apply_charges", { p_company_id: companyId });
      if (error) throw new Error(`No se pudieron aplicar los cobros: ${error.message}`);
      applied += Number(data ?? 0);
    }

    return jsonResponse({ connected: true, subscriptions: subscriptions.length, charges: chargeCount, applied });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Error inesperado" }, 400);
  }
});
