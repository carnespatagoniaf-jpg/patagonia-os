// Resumen diario del panel de plataforma por WhatsApp (migración 209).
//
// La llaman:
// * la base, cada hora (pg_cron → daily_summary_tick), con el encabezado x-daily-summary-token. Solo manda si está
//   prendido, si es la hora elegida (hora argentina) y si hoy todavía no se mandó.
// * el panel, con la sesión de un administrador de plataforma: { "mode": "preview" } devuelve el texto sin mandar;
//   { "mode": "send" } lo manda ya a los números cargados (botón "Probar ahora").
//
// Secretos (Edge Functions → Secrets): WHATSAPP_TOKEN (token permanente de un usuario del sistema de Meta) y
// WHATSAPP_PHONE_NUMBER_ID (el id del número nuevo, no el número). Opcionales: WHATSAPP_TEMPLATE (por defecto
// resumen_diario), WHATSAPP_TEMPLATE_LANG (es_AR), WHATSAPP_API_VERSION (v23.0), BRAND_NAME (Patagonia System).
// Sin los dos primeros no manda nada: guarda el texto en last_result para ver qué hubiera mandado.
// Si el dueño eligió cuenta y precio (migración 210), cada envío anota un gasto "WhatsApp" en Finanzas.
// Deploy con --no-verify-jwt (la base la llama sin sesión; la sesión del panel se revisa acá adentro).

import { createClient } from "npm:@supabase/supabase-js@2";
import { argentinaHour, previewText, templateParams, toWhatsAppNumber, type SummaryData } from "./summary.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const WA_TOKEN = (Deno.env.get("WHATSAPP_TOKEN") ?? "").trim();
const WA_PHONE_ID = (Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "").trim();
const TEMPLATE = (Deno.env.get("WHATSAPP_TEMPLATE") ?? "resumen_diario").trim();
const TEMPLATE_LANG = (Deno.env.get("WHATSAPP_TEMPLATE_LANG") ?? "es_AR").trim();
const API_VERSION = (Deno.env.get("WHATSAPP_API_VERSION") ?? "v23.0").trim();
const BRAND = (Deno.env.get("BRAND_NAME") ?? "Patagonia System").trim();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

/** Comparación en tiempo constante del token de la base. */
function sameKey(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sendTemplate(to: string, params: string[]): Promise<{ to: string; ok: boolean; error?: string }> {
  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: TEMPLATE,
        language: { code: TEMPLATE_LANG },
        components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }]
      }
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (res.ok) return { to, ok: true };
  const body = await res.text();
  let message = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.error_data?.details ?? parsed?.error?.message ?? message;
  } catch {
    // queda el texto crudo
  }
  return { to, ok: false, error: `Meta respondió ${res.status}: ${message}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: true });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: schedule, error: schedErr } = await admin.from("daily_summary_schedule").select("*").eq("id", 1).maybeSingle();
  if (schedErr || !schedule) return json({ error: "Falta la migración 209" }, 500);

  // ¿Quién llama? La base (token) o un administrador de plataforma (sesión).
  let mode: "cron" | "preview" | "send" = "cron";
  const cronToken = req.headers.get("x-daily-summary-token") ?? "";
  if (!sameKey(cronToken, schedule.token)) {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "No autorizado" }, 401);
    const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: isAdmin } = await asUser.rpc("am_i_platform_admin");
    if (isAdmin !== true) return json({ error: "Solo un administrador de la plataforma puede hacer esto." }, 403);
    const body = await req.json().catch(() => ({}));
    mode = body?.mode === "send" ? "send" : "preview";
  }

  const now = Date.now();
  const save = (patch: Record<string, unknown>) =>
    admin.from("daily_summary_schedule").update({ ...patch, last_run_at: new Date(now).toISOString() }).eq("id", 1);

  if (mode === "cron") {
    if (!schedule.enabled) return json({ skipped: "apagado" });
    if (argentinaHour(now) !== schedule.send_hour) return json({ skipped: "no es la hora" });
  }

  const { data, error } = await admin.rpc("platform_daily_summary_data");
  if (error || !data) {
    if (mode === "cron") await save({ last_result: { error: error?.message ?? "sin datos" } });
    return json({ error: error?.message ?? "No se pudieron leer los datos" }, 500);
  }
  const summary = data as SummaryData;
  if (mode === "cron" && schedule.last_sent_on === summary.today) return json({ skipped: "ya se mandó hoy" });

  const params = templateParams(BRAND, summary, now);
  const text = previewText(params);
  if (mode === "preview") return json({ text, params, configured: Boolean(WA_TOKEN && WA_PHONE_ID), recipients: schedule.recipients });

  const recipients = ((schedule.recipients ?? []) as string[]).map(toWhatsAppNumber).filter((n): n is string => Boolean(n));
  if (!WA_TOKEN || !WA_PHONE_ID) {
    const result = { dryRun: true, reason: "Faltan los secretos WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID", text };
    await save({ last_result: result, ...(mode === "cron" ? { last_sent_on: summary.today } : {}) });
    return json(result);
  }
  if (recipients.length === 0) {
    const result = { error: "No hay números cargados" };
    await save({ last_result: result });
    return json(result, 400);
  }

  const results = [];
  for (const to of recipients) results.push(await sendTemplate(to, params));
  const sent = results.filter((r) => r.ok).length;

  // Migración 210: el costo se anota solo en Finanzas (cuenta y precio por mensaje que eligió el dueño).
  let cost: { amount: number; error?: string } | null = null;
  const price = Number(schedule.cost_per_message ?? 0);
  if (sent > 0 && schedule.cost_account_id && price > 0) {
    const amount = Math.round(sent * price * 100) / 100;
    if (amount > 0) {
      const key = mode === "cron" ? `resumen|${summary.today}` : `resumen-prueba|${new Date(now).toISOString()}`;
      const { error: costErr } = await admin.from("platform_fin_movements").upsert(
        {
          whatsapp_key: key,
          occurred_on: summary.today,
          account_id: schedule.cost_account_id,
          kind: "gasto",
          direction: "out",
          amount,
          category: "WhatsApp",
          description: `Resumen diario por WhatsApp (${sent} ${sent === 1 ? "mensaje" : "mensajes"}${mode === "cron" ? "" : ", prueba"})`
        },
        { onConflict: "whatsapp_key" }
      );
      cost = costErr ? { amount, error: costErr.message } : { amount };
    }
  }

  const result = { sent, failed: results.filter((r) => !r.ok), text, mode, cost };
  // Se marca el día aunque alguno falle, así no le llegan diez mensajes si Meta rechaza uno.
  await save({ last_result: result, ...(mode === "cron" ? { last_sent_on: summary.today } : {}) });
  return json(result, sent > 0 ? 200 : 502);
});
