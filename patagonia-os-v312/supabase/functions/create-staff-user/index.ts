// Da de alta un usuario nuevo (login + perfil) para una sucursal de la empresa
// del que llama. Corre con la service role key —por eso es una Edge Function
// y no un RPC SQL normal: crear un usuario en auth.users requiere el Admin
// API de Supabase, no un insert directo.
//
// Deploy: Supabase Dashboard → Edge Functions → "Deploy a new function",
// pegar este archivo (o `supabase functions deploy create-staff-user` con el CLI).
// SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY ya están
// disponibles automáticamente como variables de entorno en toda función.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ROLES = ["admin", "manager", "cashier", "production", "readonly", "accountant"];

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

/**
 * Los errores de Supabase Auth vienen en inglés ("Password is known to be weak
 * and easy to guess…"): el 09/11 el dueño no entendió por qué no se creaba un
 * usuario. Acá se pasan a castellano los que puede causar lo que se escribió.
 */
function authErrorText(err: { message?: string; code?: string } | null): string {
  const code = err?.code ?? "";
  const msg = (err?.message ?? "").toLowerCase();
  if (code === "weak_password" || msg.includes("weak") || msg.includes("easy to guess")) {
    return "Esa contraseña es muy común y es fácil de adivinar. Elegí otra que no sea conocida, por ejemplo mezclando palabras con números (Patagonia.Caja.2026).";
  }
  if (code === "email_exists" || code === "user_already_exists" || msg.includes("already been registered") || msg.includes("already registered")) {
    return "Ya existe un usuario con ese email. Usá otro email, o si es de esta persona, editá el usuario que ya está en la lista.";
  }
  if (code === "email_address_invalid" || msg.includes("invalid format") || (msg.includes("email") && msg.includes("invalid"))) {
    return "Ese email no es válido. Revisá que esté bien escrito.";
  }
  if (msg.includes("password should") || msg.includes("password must")) {
    return "La contraseña no cumple los requisitos: usá al menos 8 caracteres.";
  }
  return err?.message ? `No se pudo crear el usuario: ${err.message}` : "No se pudo crear el usuario.";
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
    if (!["owner", "admin"].includes(callerProfile.role)) throw new Error("No autorizado para crear usuarios");

    const body = await req.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    const fullName = String(body.fullName ?? "").trim();
    const role = String(body.role ?? "");
    const branchId = String(body.branchId ?? "");
    const password = String(body.password ?? "");

    if (!email || !email.includes("@")) throw new Error("Ingresá un email válido");
    if (!fullName) throw new Error("El nombre es obligatorio");
    if (!ALLOWED_ROLES.includes(role)) throw new Error("Rol inválido");
    if (!branchId) throw new Error("La sucursal es obligatoria");
    if (password.length < 8) throw new Error("La contraseña tiene que tener al menos 8 caracteres");

    const { data: branch, error: branchErr } = await admin
      .from("branches")
      .select("id")
      .eq("id", branchId)
      .eq("company_id", callerProfile.company_id)
      .maybeSingle();
    if (branchErr || !branch) throw new Error("Sucursal inválida");

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });
    if (createErr || !created.user) throw new Error(authErrorText(createErr));

    const { error: insertErr } = await admin.from("profiles").insert({
      id: created.user.id,
      company_id: callerProfile.company_id,
      branch_id: branchId,
      full_name: fullName,
      role,
      active: true
    });
    if (insertErr) {
      await admin.auth.admin.deleteUser(created.user.id);
      throw new Error(insertErr.message);
    }

    await admin.from("audit_log").insert({
      company_id: callerProfile.company_id,
      branch_id: branchId,
      user_id: callerAuth.user.id,
      action: "user.create",
      entity_type: "profile",
      entity_id: created.user.id,
      new_data: { email, full_name: fullName, role }
    });

    return jsonResponse({ id: created.user.id, email });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Error inesperado" }, 400);
  }
});
