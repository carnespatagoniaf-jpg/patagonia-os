// Canal de Patagonia Scale Connect con la nube (migración 225, plan balanzas v2 §5.4).
//
// Lo llama SOLO el servicio de Windows de cada PC vinculada, con el encabezado
// `x-scale-connector: <id>.<secreto>` (lo entregó scale-connect-pair una vez). No usa la sesión de un usuario:
// se despliega con --no-verify-jwt (publicar.yml, SIN_SESION). Sin CORS: un navegador no lo puede usar.
//
// Rutas (POST, JSON):
//   /claim      {wait: 0..25}  → {job: {...} | null}       toma el próximo trabajo (consulta larga hasta 25 s)
//   /progress   {job_id, seq, done, total, text, items[]}  avance y resultados por producto
//   /finish     {job_id, status, counters, items[], error} cierra el trabajo
//   /heartbeat  {version, scales[]}                        latido (cada 60 s)
//   /config     {}                                         sus balanzas (solo las de SU sucursal)
//
// Cada llamada a la base vuelve a validar la credencial (id + SHA-256 del secreto): revocar corta en el próximo
// pedido, incluso a mitad de una consulta larga. La base limita a 240 pedidos por minuto por conector y nunca
// devuelve datos de otra empresa (cada función filtra por la empresa del conector).
// Lógica pura y pruebas: connect.ts / apps/web/src/features/scales/scale-connect-server.test.ts.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  apiRoute,
  CONNECTOR_HEADER,
  json,
  LONG_POLL_STEP_MS,
  maxBodyFor,
  parseClaimRequest,
  parseConnectorCredential,
  parseFinishRequest,
  parseHeartbeatRequest,
  parseProgressRequest,
  readJsonLimited,
  rpcErrorBody,
  rpcErrorStatus,
  sha256Hex
} from "./connect.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "metodo_no_permitido" }, 405);
  const route = apiRoute(new URL(req.url).pathname);
  if (!route) return json({ ok: false, error: "no_existe" }, 404);

  const credential = parseConnectorCredential(req.headers.get(CONNECTOR_HEADER));
  if (!credential) return json({ ok: false, error: "credencial_invalida" }, 401);
  const body = await readJsonLimited(req, maxBodyFor(route));
  if (!body.ok) return json({ ok: false, error: body.error }, body.error === "muy_grande" ? 413 : 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const auth = { p_connector_id: credential.id, p_secret_hash: await sha256Hex(credential.secret) };
  const fail = (error: { code?: string; message?: string }) => json(rpcErrorBody(error), rpcErrorStatus(error.code));

  try {
    if (route === "claim") {
      const parsed = parseClaimRequest(body.value);
      if (!parsed.ok) return json(parsed, 400);
      const deadline = Date.now() + parsed.value.waitSec * 1000;
      for (;;) {
        const { data, error } = await admin.rpc("scale_connector_claim_job", auth);
        if (error) return fail(error);
        if (data) return json({ ok: true, job: data });
        if (Date.now() + LONG_POLL_STEP_MS > deadline || req.signal.aborted) return json({ ok: true, job: null });
        await sleep(LONG_POLL_STEP_MS, req.signal);
      }
    }

    if (route === "progress") {
      const parsed = parseProgressRequest(body.value);
      if (!parsed.ok) return json(parsed, 400);
      const p = parsed.value;
      const { data, error } = await admin.rpc("scale_connector_job_progress", {
        ...auth, p_job_id: p.jobId, p_seq: p.seq, p_done: p.done, p_total: p.total, p_text: p.text, p_items: p.items
      });
      return error ? fail(error) : json({ ok: true, ...(data ?? {}) });
    }

    if (route === "finish") {
      const parsed = parseFinishRequest(body.value);
      if (!parsed.ok) return json(parsed, 400);
      const f = parsed.value;
      const { data, error } = await admin.rpc("scale_connector_finish_job", {
        ...auth, p_job_id: f.jobId, p_status: f.status, p_counters: f.counters, p_items: f.items, p_error: f.error
      });
      return error ? fail(error) : json({ ok: true, result: data });
    }

    if (route === "heartbeat") {
      const parsed = parseHeartbeatRequest(body.value);
      if (!parsed.ok) return json(parsed, 400);
      const { data, error } = await admin.rpc("scale_connector_heartbeat", { ...auth, p_version: parsed.value.version, p_scales: parsed.value.scales });
      return error ? fail(error) : json(data);
    }

    const { data, error } = await admin.rpc("scale_connector_config", auth);
    return error ? fail(error) : json({ ok: true, ...(data ?? {}) });
  } catch (e) {
    console.error("scale-connect-api", route, e instanceof Error ? e.message : String(e));
    return json({ ok: false, error: "error_interno" }, 500);
  }
});
