// Trae de Meta (API de Marketing, SOLO LECTURA: permiso ads_read) lo que gastó cada campaña por día y lo anota en
// Finanzas como gasto de "Publicidad", uno por campaña y día (meta_key). Si Meta corrige un día, se actualiza.
// Solo la llama un platform admin (botón en Finanzas o al abrir la pestaña). Migración 159.
//
// Deploy: `npx supabase functions deploy meta-ads-sync --project-ref <ref>`.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH = "https://graph.facebook.com/v24.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

interface InsightRow {
  campaign_id: string;
  campaign_name: string;
  spend: string;
  date_start: string;
  account_currency?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método no permitido" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Falta autenticación");
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: callerAuth, error: callerAuthErr } = await callerClient.auth.getUser();
    if (callerAuthErr || !callerAuth.user) throw new Error("Usuario no autenticado");
    const { data: isAdmin } = await admin.from("platform_admins").select("user_id").eq("user_id", callerAuth.user.id).maybeSingle();
    if (!isAdmin) throw new Error("No autorizado");

    const { data: settings, error: settingsErr } = await admin.from("platform_meta_settings").select("*").eq("id", true).maybeSingle();
    if (settingsErr) throw new Error(settingsErr.message);
    if (!settings) return jsonResponse({ connected: false });

    // Desde 2 días antes de lo último traído (Meta ajusta los últimos días), o 60 días la primera vez. Hasta ayer y hoy.
    const today = new Date(Date.now() - 3 * 3600_000);
    const since = settings.last_sync_until
      ? new Date(new Date(settings.last_sync_until).getTime() - 2 * 86400_000)
      : new Date(today.getTime() - 60 * 86400_000);
    const timeRange = JSON.stringify({ since: isoDay(since), until: isoDay(today) });

    const rows: InsightRow[] = [];
    let url: string | null =
      `${GRAPH}/act_${settings.ad_account_id}/insights?level=campaign&time_increment=1&limit=500` +
      `&fields=campaign_id,campaign_name,spend,account_currency&time_range=${encodeURIComponent(timeRange)}` +
      `&access_token=${encodeURIComponent(settings.access_token)}`;
    while (url) {
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok || body.error) {
        const msg = body?.error?.message ?? `Meta respondió ${res.status}`;
        await admin.from("platform_meta_settings").update({ last_error: msg, last_sync_at: new Date().toISOString() }).eq("id", true);
        throw new Error(`Meta: ${msg}`);
      }
      rows.push(...(body.data ?? []));
      url = body.paging?.next ?? null;
    }

    // Meta cobra en la moneda de la cuenta publicitaria: el gasto va a una cuenta de Finanzas en esa misma moneda.
    const metaCurrency = rows.find((r) => r.account_currency)?.account_currency ?? null;
    const { data: finAccount } = await admin.from("platform_fin_accounts").select("currency, name").eq("id", settings.account_id).maybeSingle();
    if (metaCurrency && finAccount && metaCurrency !== finAccount.currency) {
      const msg = `La cuenta publicitaria cobra en ${metaCurrency} y "${finAccount.name}" es en ${finAccount.currency}: elegí una cuenta en ${metaCurrency}.`;
      await admin.from("platform_meta_settings").update({ last_error: msg, last_sync_at: new Date().toISOString() }).eq("id", true);
      throw new Error(msg);
    }

    let saved = 0;
    for (const r of rows) {
      const amount = Math.round(Number(r.spend) * 100) / 100;
      const key = `${r.campaign_id}|${r.date_start}`;
      if (!(amount > 0)) {
        await admin.from("platform_fin_movements").delete().eq("meta_key", key);
        continue;
      }
      const { error } = await admin.from("platform_fin_movements").upsert(
        {
          meta_key: key,
          occurred_on: r.date_start,
          account_id: settings.account_id,
          kind: "gasto",
          direction: "out",
          amount,
          category: "Publicidad",
          description: `Meta: ${r.campaign_name}`,
          from_investment: settings.from_investment
        },
        { onConflict: "meta_key" }
      );
      if (error) throw new Error(error.message);
      saved++;
    }

    await admin
      .from("platform_meta_settings")
      .update({ last_sync_at: new Date().toISOString(), last_sync_until: isoDay(today), last_error: null })
      .eq("id", true);
    return jsonResponse({ connected: true, days: rows.length, saved, currency: rows[0]?.account_currency ?? null, since: isoDay(since) });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Error inesperado" }, 400);
  }
});
