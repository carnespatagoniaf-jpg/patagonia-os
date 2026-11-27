// Vinculación de Patagonia Scale Connect (migración 225, plan balanzas v2 §5.4 y §5.7).
//
// La llama el servicio de Windows desde su página local (127.0.0.1:9120/vincular) con el código de 8 caracteres
// que el dueño o un administrador ve en Mis balanzas → "Agregar esta computadora". No hay sesión de usuario: el
// código ES la autorización (10 minutos, un solo uso). Se despliega con --no-verify-jwt (publicar.yml, SIN_SESION).
//
// POST {code, name, fingerprint (SHA-256 hex de la huella de la PC), version, recover_id?, force_new?}
//   200 {ok, connector_id, secret, name, branch_id, recovered}   el secreto se devuelve UNA sola vez
//   409 {ok:false, error:"elegir", candidates:[{id,name,last_seen_at}]}   misma huella: "¿Es Caja 1?"
//   429 demasiados intentos desde esa IP (10 cada 10 minutos) o en total
//   400 código inválido (vencido, usado o inexistente dan lo mismo), nombre repetido, etc.
//
// El secreto se genera acá (32 bytes al azar) y a la base solo va su SHA-256. La IP tampoco se guarda: solo su
// hash, para contar intentos fallidos. Sin CORS: un navegador no lo puede usar (lo llama el servicio, no la página).
// Lógica pura y pruebas: ../scale-connect-api/connect.ts.

import { createClient } from "npm:@supabase/supabase-js@2";
import { clientAddress, generateSecret, json, MAX_PAIR_BODY, pairStatus, parsePairRequest, readJsonLimited, sha256Hex } from "../scale-connect-api/connect.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "metodo_no_permitido" }, 405);
  const body = await readJsonLimited(req, MAX_PAIR_BODY);
  if (!body.ok) return json({ ok: false, error: body.error }, body.error === "muy_grande" ? 413 : 400);
  const parsed = parsePairRequest(body.value);
  if (!parsed.ok) return json(parsed, 400);
  const p = parsed.value;

  const secret = generateSecret();
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  try {
    const { data, error } = await admin.rpc("scale_connector_redeem_pairing", {
      p_code: p.code,
      p_name: p.name,
      p_fingerprint_hash: p.fingerprintHash,
      p_secret_hash: await sha256Hex(secret),
      p_version: p.version,
      p_client_hash: await sha256Hex(`scale-connect-pair|${clientAddress(req.headers)}`),
      p_recover_id: p.recoverId,
      p_force_new: p.forceNew
    });
    if (error) {
      console.error("scale-connect-pair", error.code, error.message);
      return json({ ok: false, error: "error_interno" }, 500);
    }
    const result = (data ?? {}) as { ok?: boolean; error?: string };
    if (!result.ok) return json(result, pairStatus(result));
    return json({ ...result, secret });
  } catch (e) {
    console.error("scale-connect-pair", e instanceof Error ? e.message : String(e));
    return json({ ok: false, error: "error_interno" }, 500);
  }
});
