// Da de alta un cliente nuevo (empresa + primera sucursal + login del
// dueño) en la base compartida. Solo lo puede llamar un platform admin
// (tabla platform_admins, no un dueño de empresa) — un dueño está atado a
// su propia company_id y nunca debería poder crear ni ver otras empresas.
// Corre con la service role key por el mismo motivo que create-staff-user:
// crear un login nuevo requiere el Admin API de Supabase, no un insert
// directo.
//
// Deploy: Supabase Dashboard → Edge Functions → "Deploy a new function",
// pegar este archivo (o `supabase functions deploy create-client` con el CLI).

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
    if (adminCheckErr || !isPlatformAdmin) throw new Error("No autorizado para crear clientes");

    const body = await req.json();
    const companyName = String(body.companyName ?? "").trim();
    const branchName = String(body.branchName ?? "").trim();
    const ownerFullName = String(body.ownerFullName ?? "").trim();
    const ownerEmail = String(body.ownerEmail ?? "").trim().toLowerCase();

    if (!companyName) throw new Error("El nombre del negocio es obligatorio");
    if (!branchName) throw new Error("El nombre de la sucursal es obligatorio");
    if (!ownerFullName) throw new Error("El nombre del dueño es obligatorio");
    if (!ownerEmail || !ownerEmail.includes("@")) throw new Error("Ingresá un email válido");

    const { data: company, error: companyErr } = await admin
      .from("companies")
      .insert({ name: companyName })
      .select("id")
      .single();
    if (companyErr || !company) throw new Error(companyErr?.message ?? "No se pudo crear la empresa");

    const { data: branch, error: branchErr } = await admin
      .from("branches")
      .insert({ company_id: company.id, name: branchName })
      .select("id")
      .single();
    if (branchErr || !branch) throw new Error(branchErr?.message ?? "No se pudo crear la sucursal");

    const tempPassword = randomTempPassword();

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: tempPassword,
      email_confirm: true
    });
    if (createErr || !created.user) throw new Error(createErr?.message ?? "No se pudo crear el usuario");

    const { error: insertErr } = await admin.from("profiles").insert({
      id: created.user.id,
      company_id: company.id,
      branch_id: branch.id,
      full_name: ownerFullName,
      // "owner" queda reservado al equipo de Patagonia OS (ve Usuarios y
      // Auditoría, herramientas internas). El dueño de un cliente real
      // arranca en "admin", el techo comercial — ve todo el paquete que se
      // vende, incluida esta pantalla de Usuarios para dar de alta a sus
      // propios cajeros/encargados.
      role: "admin",
      active: true
    });
    if (insertErr) {
      await admin.auth.admin.deleteUser(created.user.id);
      throw new Error(insertErr.message);
    }

    await admin.from("audit_log").insert({
      company_id: company.id,
      branch_id: branch.id,
      user_id: callerAuth.user.id,
      action: "client.create",
      entity_type: "company",
      entity_id: company.id,
      new_data: { company_name: companyName, branch_name: branchName, owner_email: ownerEmail }
    });

    return jsonResponse({
      companyId: company.id,
      branchId: branch.id,
      ownerId: created.user.id,
      email: ownerEmail,
      tempPassword
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Error inesperado" }, 400);
  }
});
