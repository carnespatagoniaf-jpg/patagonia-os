// Borra de verdad un cliente (empresa) -- solo si nunca tuvo actividad
// real, ver delete_company_if_unused en 075_delete_company_if_unused.sql.
// Corre con la service role key por el mismo motivo que create-client: la
// parte de base de datos la hace la función SQL (que ya chequea que esté
// vacía y borra empresa/sucursales/perfiles en una sola transacción), pero
// borrar el login de cada usuario de auth.users requiere el Admin API.
//
// Deploy: `supabase functions deploy delete-client` o pegándolo en el
// Dashboard, igual que create-client.

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
    if (adminCheckErr || !isPlatformAdmin) throw new Error("No autorizado para borrar clientes");

    const body = await req.json();
    const companyId = String(body.companyId ?? "").trim();
    if (!companyId) throw new Error("Falta el id de la empresa");

    // Este RPC hace todo el trabajo de base de datos en una sola
    // transacción: chequea que la empresa esté vacía (sin ventas, compras,
    // productos, etc.) y si lo está, borra audit_log/profiles/branches/
    // companies. Si NO está vacía, tira una excepción sin tocar nada -- acá
    // solo se propaga ese mensaje tal cual, ya viene en español y claro.
    const { data: userIds, error: rpcErr } = await admin.rpc("delete_company_if_unused", { p_company_id: companyId });
    if (rpcErr) throw new Error(rpcErr.message);

    // La parte de base de datos ya terminó bien -- ahora, mejor esfuerzo,
    // se borran los logins reales (auth.users) de cada perfil que tenía
    // esta empresa. Si alguno falla acá (raro), la empresa ya se borró
    // igual -- solo queda un login huérfano sin perfil, no un problema de
    // datos ni de acceso indebido.
    let orphanedLogins = 0;
    for (const uid of (userIds ?? []) as string[]) {
      const { error: delUserErr } = await admin.auth.admin.deleteUser(uid);
      if (delUserErr) orphanedLogins += 1;
    }

    return jsonResponse({ ok: true, orphanedLogins });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Error inesperado" }, 400);
  }
});
