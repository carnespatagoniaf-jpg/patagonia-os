// Elimina de verdad un usuario de staff (login + perfil) de la empresa del
// que llama -- a diferencia de "Inactivo" (el toggle normal en profiles.active,
// que preserva el historial), esto borra la fila de auth.users. Corre con la
// service role key por el mismo motivo que create-staff-user: borrar de
// auth.users requiere el Admin API, no un delete SQL normal.
//
// A propósito NO se valida "actividad" acá a mano: casi todas las tablas de
// negocio (pos_sales.created_by, purchases.created_by, pos_shifts.opened_by,
// treasury_movements.created_by, audit_log.user_id, etc.) tienen una FK a
// auth.users(id) sin "on delete cascade" -- si el usuario ya generó
// cualquiera de esas filas, Postgres va a rechazar el delete solo, y acá
// simplemente se traduce ese rechazo en un mensaje claro. Si el usuario
// nunca tuvo actividad real, no hay ninguna fila que lo referencie y el
// delete sale bien (profiles sí tiene "on delete cascade" desde auth.users,
// así que el perfil se borra solo).
//
// Deploy: `supabase functions deploy delete-staff-user` o pegándolo en el
// Dashboard, igual que create-staff-user.

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

    const { data: callerProfile, error: callerProfileErr } = await admin
      .from("profiles")
      .select("company_id,role,active")
      .eq("id", callerAuth.user.id)
      .single();
    if (callerProfileErr || !callerProfile || !callerProfile.active) throw new Error("Perfil inválido");
    if (!["owner", "admin"].includes(callerProfile.role)) throw new Error("No autorizado para eliminar usuarios");

    const body = await req.json();
    const targetId = String(body.id ?? "");
    if (!targetId) throw new Error("Falta el usuario a eliminar");
    if (targetId === callerAuth.user.id) throw new Error("No podés eliminar tu propio usuario");

    const { data: target, error: targetErr } = await admin
      .from("profiles")
      .select("company_id,role,full_name")
      .eq("id", targetId)
      .maybeSingle();
    if (targetErr || !target) throw new Error("Usuario inválido");
    if (target.company_id !== callerProfile.company_id) throw new Error("Usuario inválido");
    if (target.role === "owner") throw new Error("No se puede eliminar al dueño");

    const { error: deleteErr } = await admin.auth.admin.deleteUser(targetId);
    if (deleteErr) {
      const isReferenced = /foreign key|violates|referenced/i.test(deleteErr.message ?? "");
      throw new Error(
        isReferenced
          ? "Este usuario ya tiene actividad registrada (ventas, compras, turnos, etc.) y no se puede eliminar del todo -- marcalo como inactivo en su lugar."
          : deleteErr.message
      );
    }

    await admin.from("audit_log").insert({
      company_id: callerProfile.company_id,
      user_id: callerAuth.user.id,
      action: "user.delete",
      entity_type: "profile",
      entity_id: targetId,
      old_data: { full_name: target.full_name, role: target.role }
    });

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Error inesperado" }, 400);
  }
});
