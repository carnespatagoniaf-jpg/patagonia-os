// Resetea la contraseña de un usuario de cualquier empresa -- para cuando el
// mail de "olvidé mi contraseña" no le llega o no le funciona a un cliente
// (link roto, mail en spam, etc.) y el platform admin necesita darle acceso
// ya mismo sin depender de ese flujo. Solo lo puede llamar un platform admin
// (tabla platform_admins), nunca un dueño de empresa sobre otra empresa.
// Corre con la service role key porque cambiar la contraseña de otro
// usuario requiere el Admin API de Supabase, no hay RPC SQL que pueda
// tocar auth.users directamente.
//
// Deploy: Supabase Dashboard → Edge Functions, o
// `supabase functions deploy admin-reset-password` con el CLI.

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

    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: callerAuth, error: callerAuthErr } = await callerClient.auth.getUser();
    if (callerAuthErr || !callerAuth.user) throw new Error("Usuario no autenticado");

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: isPlatformAdmin, error: adminCheckErr } = await admin
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", callerAuth.user.id)
      .maybeSingle();
    if (adminCheckErr || !isPlatformAdmin) throw new Error("No autorizado para resetear contraseñas");

    const body = await req.json();
    const targetUserId = String(body.userId ?? "").trim();
    if (!targetUserId) throw new Error("Falta el id del usuario");

    // Confirma que el usuario objetivo pertenece a una empresa real (no
    // deja resetear cualquier uuid al azar) -- no hace falta que sea de
    // NINGUNA empresa en particular, el platform admin puede tocar
    // cualquier cliente, pero sí que sea un usuario de negocio real.
    const { data: targetProfile, error: targetErr } = await admin
      .from("profiles")
      .select("id, full_name, company_id")
      .eq("id", targetUserId)
      .maybeSingle();
    if (targetErr || !targetProfile) throw new Error("Usuario inválido");

    const tempPassword = randomTempPassword();
    const { error: updateErr } = await admin.auth.admin.updateUserById(targetUserId, { password: tempPassword });
    if (updateErr) throw new Error(updateErr.message);

    await admin.from("audit_log").insert({
      company_id: targetProfile.company_id,
      user_id: callerAuth.user.id,
      action: "user.password_reset_by_admin",
      entity_type: "profile",
      entity_id: targetUserId,
      new_data: { target_full_name: targetProfile.full_name }
    });

    return jsonResponse({ tempPassword });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Error inesperado" }, 400);
  }
});
