// Crea la cuenta de otro administrador de Patagonia (un socio: ve y maneja todo el panel, como el dueño) y
// devuelve una contraseña temporal para dársela. Solo lo puede llamar un platform admin (tabla platform_admins).
// Corre con la service role key porque crear un login requiere el Admin API de Supabase.
// No convierte en administrador a una cuenta que ya existe (podría ser el usuario de un cliente).
//
// Deploy: `npx supabase functions deploy add-platform-admin --project-ref <ref>`.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function randomTempPassword() {
  return `Pat${crypto.randomUUID().slice(0, 8)}!`;
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

    const body = await req.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    const fullName = String(body.fullName ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("El mail no es válido");

    const tempPassword = randomTempPassword();
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { full_name: fullName || null }
    });
    if (createErr || !created.user) {
      const msg = createErr?.message ?? "";
      if (/already|registered|exists/i.test(msg)) {
        throw new Error("Ese mail ya tiene una cuenta en Patagonia. Usá otro mail para el administrador.");
      }
      throw new Error(msg || "No se pudo crear la cuenta");
    }

    const { error: insertErr } = await admin.from("platform_admins").insert({ user_id: created.user.id });
    if (insertErr) {
      await admin.auth.admin.deleteUser(created.user.id);
      throw new Error(insertErr.message);
    }

    return jsonResponse({ email, tempPassword });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Error inesperado" }, 400);
  }
});
