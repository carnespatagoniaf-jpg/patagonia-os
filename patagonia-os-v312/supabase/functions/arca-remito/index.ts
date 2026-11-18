// Remito Electrónico Cárnico de ARCA (wsremcarne), migración 202.
//
// Separada de `arca-invoice` a propósito: la facturación no se toca. Comparte
// solo lo que es igual para todos los servicios de ARCA:
//   - el certificado del negocio (arca_company_certificates, cifrado con
//     ARCA_VAULT_KEY), o el compartido para Carnes Patagonia;
//   - el armado del pedido al WSAA (voucher.ts de arca-invoice, lógica pura).
// El ticket del WSAA es POR SERVICIO: este usa "wsremcarne" en
// arca_access_tickets, así que nunca le traba el ticket a la facturación.
// En ARCA el negocio tiene que darle a su certificado ("Computador Fiscal
// patagonia") también la relación con el servicio de remito cárnico.
//
// Acciones (POST JSON):
//   { action: "check" }              dueño/admin: dummy + permiso + puntos de emisión +
//                                    categorías/estados/carnes; si da bien, enabled = true.
//   { action: "domicilios", cuit }   códigos de domicilio de un CUIT (destino del remito).
//   { action: "send", remitoId }     manda el remito (generarRemito). Sin respuesta =
//                                    'incierto': el reintento CONSULTA a ARCA primero.
//   { action: "emit", remitoId }     emitirRemito de uno 'generado' (pendiente de emitir).
//   { action: "refresh", remitoId }  consultarRemito y actualiza el estado.
//   { action: "void", remitoId }     anularRemito (solo uno no emitido).
//
// Secretos: ARCA_ENV ("homo" en staging, "prod" en producción), ARCA_KEY,
// ARCA_CERT, ARCA_VAULT_KEY (los mismos de arca-invoice).
//
// Deploy: lo hace GitHub (publicar.yml) o a mano en staging:
//   npx supabase functions deploy arca-remito --project-ref <ref>

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import forge from "npm:node-forge@1.3.1";
import { ARCA_ENDPOINTS, loginTicketRequestXml, parseLoginResponse, wsaaLoginEnvelope } from "../arca-invoice/voucher.ts";
import {
  REMCARNE_ENDPOINTS,
  REMCARNE_SERVICE,
  anularRemitoInner,
  consultarCodigosDomicilioInner,
  consultarRemitoPorCodigoInner,
  consultarRemitoPorIdReqInner,
  consultarTiposCarneInner,
  consultarUltimoRemitoInner,
  emitirRemitoInner,
  friendlyRemcarneMessage,
  generarRemitoInner,
  parseConsultaRemito,
  parseDummy,
  parseLista,
  parseRemitoReturn,
  remcarneEnvelope,
  soapAction,
  type ArcaEnv,
  type ConsultaResult,
  type RecRemitoInput,
  type RemcarneAuth
} from "./remcarne.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ARCA_ENV: ArcaEnv = Deno.env.get("ARCA_ENV") === "prod" ? "prod" : "homo";
const ARCA_KEY = (Deno.env.get("ARCA_KEY") ?? "").replace(/\\n/g, "\n");
const ARCA_CERT = (Deno.env.get("ARCA_CERT") ?? "").replace(/\\n/g, "\n");
const ARCA_VAULT_KEY = Deno.env.get("ARCA_VAULT_KEY") ?? "";
const WS_URL = REMCARNE_ENDPOINTS[ARCA_ENV];
/** Igual que arca-invoice: solo estas empresas usan el certificado compartido (es el CUIT de Carnes Patagonia). */
const SHARED_CERT_COMPANIES: Record<ArcaEnv, string[]> = {
  prod: ["11111111-1111-1111-1111-111111111111"],
  homo: ["0295a76b-acc0-4d62-8e6b-9065bd1647ca"]
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

class UserError extends Error {}

// deno-lint-ignore no-explicit-any
type Row = any;

// ---------- certificado (misma lógica que arca-invoice, solo lectura) ----------

interface Credentials {
  keyPem: string;
  certPem: string;
  fingerprint: string;
  shared: boolean;
}

function fingerprintOf(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return forge.md.sha256.create().update(der).digest().toHex();
}

function cuitOf(cert: forge.pki.Certificate): string {
  const field = cert.subject.attributes.find((a: { type?: string }) => a.type === "2.5.4.5");
  return String(field?.value ?? "").replace(/\D/g, "");
}

async function decryptKey(cipher: string, iv: string): Promise<string> {
  if (!ARCA_VAULT_KEY) throw new Error("Falta el secreto ARCA_VAULT_KEY en la Edge Function.");
  const raw = Uint8Array.from(atob(ARCA_VAULT_KEY), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const from = (t: string) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: from(iv) }, key, from(cipher)));
}

async function credentialsFor(admin: SupabaseClient, companyId: string, cuit: string): Promise<Credentials> {
  const { data: own } = await admin.from("arca_company_certificates").select("*").eq("company_id", companyId).maybeSingle();
  if (own?.cert_pem) {
    if (own.cuit !== cuit) throw new UserError("El certificado de ARCA cargado es de otro CUIT. Revisalo en Facturas → Conectar con ARCA.");
    return { keyPem: await decryptKey(own.key_cipher, own.key_iv), certPem: own.cert_pem, fingerprint: own.cert_fingerprint, shared: false };
  }
  if (ARCA_CERT && ARCA_KEY && SHARED_CERT_COMPANIES[ARCA_ENV].includes(companyId)) {
    const cert = forge.pki.certificateFromPem(ARCA_CERT);
    if (cuitOf(cert) === cuit) return { keyPem: ARCA_KEY, certPem: ARCA_CERT, fingerprint: fingerprintOf(cert), shared: true };
  }
  throw new UserError("Falta el certificado de ARCA del negocio: primero conectá la factura electrónica (Facturas → Conectar con ARCA).");
}

function signLoginRequest(tra: string, creds: Credentials): string {
  const cert = forge.pki.certificateFromPem(creds.certPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, "utf8");
  p7.addCertificate(cert);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(creds.keyPem),
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

async function readTicket(admin: SupabaseClient, creds: Credentials) {
  const { data } = await admin
    .from("arca_access_tickets")
    .select("token,sign,expires_at")
    .eq("env", ARCA_ENV)
    .eq("service", REMCARNE_SERVICE)
    .eq("cert_key", creds.fingerprint)
    .maybeSingle();
  if (!data || new Date(data.expires_at).getTime() - Date.now() < 5 * 60_000) return null;
  return { token: data.token as string, sign: data.sign as string };
}

async function accessTicket(admin: SupabaseClient, creds: Credentials): Promise<{ token: string; sign: string }> {
  const cached = await readTicket(admin, creds);
  if (cached) return cached;
  const res = await fetch(ARCA_ENDPOINTS[ARCA_ENV].wsaa, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' },
    body: wsaaLoginEnvelope(signLoginRequest(loginTicketRequestXml(new Date(), REMCARNE_SERVICE), creds)),
    signal: AbortSignal.timeout(20_000)
  });
  const parsed = parseLoginResponse(await res.text());
  if ("fault" in parsed) {
    if (/ya posee un TA valido/i.test(parsed.fault)) {
      await new Promise((r) => setTimeout(r, 1500));
      const again = await readTicket(admin, creds);
      if (again) return again;
      throw new Error("ARCA ya entregó un permiso de conexión para el remito cárnico que todavía no venció (dura 12 horas) y no quedó guardado acá. Se libera solo; probá más tarde.");
    }
    if (/no autorizado|not authorized|computador|servicio/i.test(parsed.fault)) {
      throw new UserError(
        `ARCA no deja usar el certificado para el remito cárnico: en tu ARCA, "Administrador de Relaciones de Clave Fiscal", hay que darle al certificado (computador fiscal "patagonia") la relación con el web service del remito cárnico. Detalle: ${parsed.fault}`
      );
    }
    throw new Error(`ARCA no aceptó el certificado: ${parsed.fault}`);
  }
  await admin.from("arca_access_tickets").upsert({
    env: ARCA_ENV,
    service: REMCARNE_SERVICE,
    cert_key: creds.fingerprint,
    token: parsed.token,
    sign: parsed.sign,
    expires_at: parsed.expiresAt,
    updated_at: new Date().toISOString()
  });
  return { token: parsed.token, sign: parsed.sign };
}

// ---------- llamadas al web service, todas registradas en rec_arca_calls ----------

interface CallContext {
  admin: SupabaseClient;
  companyId: string;
  remitoId?: string | null;
}

/** Devuelve el XML de respuesta, o null si no hubo respuesta (corte, timeout). */
async function ws(ctx: CallContext, method: string, auth: RemcarneAuth | null, inner = ""): Promise<string | null> {
  const body = remcarneEnvelope(method, auth, inner);
  let text: string | null = null;
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(WS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: soapAction(method) },
      body,
      signal: AbortSignal.timeout(30_000)
    });
    status = res.status;
    text = await res.text();
    if (!res.ok && !/Envelope/.test(text)) {
      error = `HTTP ${res.status}`;
      text = null;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "sin respuesta";
  }
  // Nunca se guarda el token ni la firma.
  const safeRequest = body.replace(/<token>[^<]*<\/token>/, "<token>…</token>").replace(/<sign>[^<]*<\/sign>/, "<sign>…</sign>");
  await ctx.admin.from("rec_arca_calls").insert({
    company_id: ctx.companyId,
    remito_id: ctx.remitoId ?? null,
    env: ARCA_ENV,
    method,
    request_xml: safeRequest.slice(0, 50_000),
    response_xml: text ? text.slice(0, 50_000) : null,
    http_status: status,
    error
  });
  return text;
}

// ---------- quién llama ----------

async function caller(req: Request, admin: SupabaseClient) {
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await userClient.auth.getUser();
  const user = userData?.user;
  if (!user) throw new UserError("Sesión vencida: volvé a entrar.");
  const { data: profile } = await admin.from("profiles").select("company_id,role,active").eq("id", user.id).maybeSingle();
  if (!profile?.active || !profile.company_id) throw new UserError("Perfil inválido.");
  const { data: company } = await admin.from("companies").select("active,plan").eq("id", profile.company_id).maybeSingle();
  if (!company?.active) throw new UserError("La empresa está desactivada.");
  if (!["full", "empresa", "planta"].includes(company.plan)) throw new UserError("El remito electrónico cárnico está en el plan Full.");
  return { userId: user.id as string, companyId: profile.company_id as string, role: profile.role as string };
}

async function authFor(admin: SupabaseClient, companyId: string): Promise<RemcarneAuth> {
  const { data: fiscal } = await admin.from("company_fiscal_settings").select("cuit").eq("company_id", companyId).maybeSingle();
  if (!fiscal?.cuit) throw new UserError("Faltan los datos fiscales del negocio (Facturas).");
  const ticket = await accessTicket(admin, await credentialsFor(admin, companyId, fiscal.cuit));
  return { ...ticket, cuit: fiscal.cuit };
}

// ---------- "Probar conexión" ----------

async function checkConnection(admin: SupabaseClient, companyId: string, userId: string) {
  const ctx: CallContext = { admin, companyId };
  const save = async (ok: boolean, message: string, extra: Record<string, unknown> = {}) => {
    await admin.from("rec_settings").upsert({
      company_id: companyId,
      enabled: ok,
      last_check_at: new Date().toISOString(),
      last_check_ok: ok,
      last_check_message: message,
      updated_at: new Date().toISOString(),
      ...extra
    });
    await admin.from("audit_log").insert({ company_id: companyId, user_id: userId, action: "rec.check", entity_type: "company", entity_id: companyId, new_data: { ok, message, env: ARCA_ENV } });
    return { ok, message, env: ARCA_ENV };
  };

  try {
    const dummyXml = await ws(ctx, "dummy", null);
    const dummy = dummyXml ? parseDummy(dummyXml) : { ok: false, detail: "sin respuesta" };
    if (!dummy.ok) return save(false, `El servicio de remito cárnico de ARCA no está disponible ahora (${dummy.detail}). Probá en un rato.`);

    const auth = await authFor(admin, companyId);

    // Puntos de emisión que ARCA tiene para este CUIT.
    const ptsXml = await ws(ctx, "consultarPuntosEmision", auth);
    if (!ptsXml) return save(false, "ARCA no respondió al consultar los puntos de emisión.");
    const pts = parseLista(ptsXml, "arrayPuntosEmision");
    // 1500 "No se han encontrado datos" = el CUIT no tiene ningún punto para este servicio (visto en producción
    // el 2026-11-18): no es un error de conexión, se siguen trayendo las tablas para dejar la pantalla lista.
    const ptsErrores = pts.errores.filter((e) => e.codigo !== "1500");
    if (pts.fault || ptsErrores.length > 0) return save(false, friendlyRemcarneMessage({ errores: ptsErrores, fault: pts.fault }));

    const { data: points } = await admin.from("rec_points").select("*").eq("company_id", companyId).eq("active", true);
    const missing: number[] = [];
    for (const p of points ?? []) {
      const found = pts.items.find((i) => Number(i.codigo) === Number(p.point_of_emission));
      if (found) await admin.from("rec_points").update({ arca_description: found.descripcion }).eq("id", p.id);
      else missing.push(p.point_of_emission);
    }

    // Tablas de ARCA (no están en el manual): se guardan para la pantalla.
    const lista = async (method: string, arr: string, inner = "") => {
      const xml = await ws(ctx, method, auth, inner);
      return xml ? parseLista(xml, arr).items : [];
    };
    const categoriasEmisor = await lista("consultarTiposCategoriaEmisor", "arrayCategoriasEmisor");
    const categoriasReceptor = await lista("consultarTiposCategoriaReceptor", "arrayCategoriasReceptor");
    const estados = await lista("consultarTiposEstado", "arrayTiposEstado");
    const grupos = await lista("consultarGruposCarne", "arrayGruposCarne");
    const tiposCarne: { grupo: string; codigo: string; descripcion: string }[] = [];
    for (const g of grupos) {
      for (const t of await lista("consultarTiposCarne", "arrayTiposCarne", consultarTiposCarneInner(g.codigo))) {
        tiposCarne.push({ grupo: g.codigo, ...t });
      }
    }
    const domXml = await ws(ctx, "consultarCodigosDomicilio", auth, consultarCodigosDomicilioInner(auth.cuit));
    const domiciliosPropios = domXml ? parseLista(domXml, "arrayDomicilios").items : [];

    const catalog = {
      env: ARCA_ENV,
      fetchedAt: new Date().toISOString(),
      puntosEmision: pts.items,
      categoriasEmisor,
      categoriasReceptor,
      estados,
      grupos,
      tiposCarne,
      domiciliosPropios
    };

    // Manual de ARCA (1.5 y 3.1): el punto de emisión tiene que estar asociado a un domicilio COMERCIAL.
    const domicilioAviso =
      ' Se da de alta en "Administración de Puntos de Venta y Domicilios" para el sistema "Remito Electrónico Web Services", asociado a un domicilio COMERCIAL (si la mercadería sale del domicilio fiscal, primero hay que declarar esa misma dirección como domicilio comercial en el Sistema Registral).';
    if ((points ?? []).length === 0) {
      const list = pts.items.map((i) => i.codigo).join(", ");
      return save(
        false,
        list
          ? `Conectado con ARCA, pero falta cargar el punto de emisión (ARCA tiene: ${list}).`
          : `Conectado con ARCA, pero ARCA no tiene ningún punto de emisión de remito cárnico para este CUIT.${domicilioAviso}`,
        { catalog }
      );
    }
    if (missing.length > 0) {
      const list = pts.items.map((i) => i.codigo).join(", ");
      return save(
        false,
        `Conectado con ARCA, pero ARCA todavía no reconoce el punto de emisión ${missing.join(", ")} para el remito cárnico${list ? ` (ARCA tiene: ${list})` : ""}.${domicilioAviso}`,
        { catalog }
      );
    }
    if (categoriasEmisor.length === 0) return save(false, "ARCA no devolvió las categorías de emisor.", { catalog });

    const ultimos: string[] = [];
    for (const p of points ?? []) {
      const xml = await ws(ctx, "consultarUltimoRemitoEmitido", auth, consultarUltimoRemitoInner(p.point_of_emission));
      const c = xml ? parseConsultaRemito(xml) : null;
      ultimos.push(`${p.point_of_emission}: ${c?.datosEmision ? `último remito ${c.datosEmision.nroRemito}` : "sin remitos emitidos"}`);
    }
    const { data: settings } = await admin.from("rec_settings").select("categoria_emisor").eq("company_id", companyId).maybeSingle();
    const env = ARCA_ENV === "homo" ? " (ambiente de PRUEBA)" : "";
    const falta = settings?.categoria_emisor == null ? " Falta elegir la categoría del emisor." : "";
    return save(true, `Conectado con el remito cárnico de ARCA${env}. Puntos de emisión: ${ultimos.join("; ")}.${falta}`, { catalog });
  } catch (err) {
    return save(false, err instanceof Error ? err.message : "No se pudo conectar con ARCA.");
  }
}

// ---------- mandar / consultar ----------

async function loadRemito(admin: SupabaseClient, companyId: string, id: string) {
  const { data: rem } = await admin.from("rec_remitos").select("*").eq("id", id).eq("company_id", companyId).maybeSingle();
  if (!rem) throw new UserError("Remito inexistente.");
  return rem as Row;
}

async function update(admin: SupabaseClient, id: string, fields: Record<string, unknown>): Promise<Row> {
  const { data, error } = await admin.from("rec_remitos").update({ ...fields, claimed_at: null }).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

function emittedFields(d: { nroRemito: number; codAutorizacion: string; fechaEmision: string; fechaVencimiento: string }, qr: string | null, estado: string | null) {
  return {
    status: "emitido",
    arca_estado: estado,
    nro_remito: d.nroRemito,
    cod_autorizacion: d.codAutorizacion,
    fecha_emision: d.fechaEmision,
    fecha_vencimiento: d.fechaVencimiento,
    ...(qr ? { qr_base64: qr } : {}),
    emitted_at: new Date().toISOString(),
    error_message: null
  };
}

/** Aplica lo que ARCA dice que tiene (consulta) sobre nuestro remito. */
async function adopt(admin: SupabaseClient, rem: Row, c: ConsultaResult): Promise<Row> {
  if (c.datosEmision) return update(admin, rem.id, { cod_remito: c.codRemito, ...emittedFields(c.datosEmision, c.qr, c.estado) });
  return update(admin, rem.id, { status: "generado", cod_remito: c.codRemito, arca_estado: c.estado, error_message: null });
}

async function claim(admin: SupabaseClient, rem: Row, statuses: string[]): Promise<Row | null> {
  const cutoff = new Date(Date.now() - 300_000).toISOString();
  const { data } = await admin
    .from("rec_remitos")
    .update({ claimed_at: new Date().toISOString(), attempts: Number(rem.attempts ?? 0) + 1 })
    .eq("id", rem.id)
    .in("status", statuses)
    .or(`claimed_at.is.null,claimed_at.lt.${cutoff}`)
    .select()
    .maybeSingle();
  return data;
}

async function send(admin: SupabaseClient, companyId: string, remitoId: string): Promise<Row> {
  const current = await loadRemito(admin, companyId, remitoId);
  if (!["pendiente", "incierto"].includes(current.status)) return current;
  const rem = await claim(admin, current, ["pendiente", "incierto"]);
  if (!rem) throw new UserError("Ese remito se está mandando en este momento.");
  const ctx: CallContext = { admin, companyId, remitoId };

  try {
    const auth = await authFor(admin, companyId);

    // 1) Si ya se mandó antes (o no se sabe), primero se pregunta a ARCA por nuestro idReq.
    if (rem.sent_at || rem.status === "incierto") {
      const xml = await ws(ctx, "consultarRemito", auth, consultarRemitoPorIdReqInner(Number(rem.id_req), rem.point_of_emission));
      const c = xml ? parseConsultaRemito(xml) : null;
      if (c?.found) return adopt(admin, rem, c);
      if (!c || c.found === null) {
        return update(admin, rem.id, { status: "incierto", error_message: "ARCA no pudo confirmar el envío anterior. Volvé a tocar \"Reintentar\" en un rato." });
      }
      // found === false: ARCA no lo tiene. Se vuelve a mandar con el MISMO idReq (ARCA no lo duplica).
    }

    // 2) Mandarlo.
    const { data: items } = await admin.from("rec_remito_items").select("*").eq("remito_id", rem.id).order("orden");
    const input: RecRemitoInput = {
      tipoMovimiento: rem.tipo_movimiento,
      categoriaEmisor: rem.categoria_emisor,
      puntoEmision: rem.point_of_emission,
      cuitTitularMercaderia: rem.cuit_emisor,
      cuitDepositario: null,
      tipoReceptor: rem.tipo_receptor,
      categoriaReceptor: rem.categoria_receptor,
      // A un depósito propio (EM) no va el CUIT: ARCA responde 1312. Cubre borradores guardados antes de la 203.
      cuitReceptor: rem.tipo_receptor === "EM" ? null : rem.cuit_receptor,
      codDomOrigen: null,
      codDomDestino: rem.cod_dom_destino,
      viaje: {
        cuitTransportista: rem.cuit_transportista,
        cuitConductor: rem.cuit_conductor,
        fechaInicioViaje: rem.fecha_inicio_viaje,
        distanciaKm: Number(rem.distancia_km),
        dominioVehiculo: rem.dominio_vehiculo,
        dominioAcoplado: rem.dominio_acoplado
      },
      items: (items ?? []).map((i: Row) => ({
        orden: i.orden,
        codTipoProd: i.cod_tipo_prod,
        tropa: i.tropa === null ? null : Number(i.tropa),
        kilos: i.kilos === null ? null : Number(i.kilos),
        unidades: i.unidades === null ? null : Number(i.unidades)
      })),
      codRemRedestinado: null
    };
    await admin.from("rec_remitos").update({ sent_at: new Date().toISOString(), env: ARCA_ENV }).eq("id", rem.id);
    const xml = await ws(ctx, "generarRemito", auth, generarRemitoInner(Number(rem.id_req), input));
    if (!xml) return update(admin, rem.id, { status: "incierto", error_message: "ARCA no respondió. Antes de reintentar se le pregunta si lo recibió." });

    const r = parseRemitoReturn(xml);
    if (r.fault) {
      // Error excepcional (firma, estructura): ARCA no procesó el pedido.
      return update(admin, rem.id, { status: "rechazado", error_message: friendlyRemcarneMessage(r) });
    }
    if (r.resultado === "R") {
      return update(admin, rem.id, { status: "rechazado", error_message: friendlyRemcarneMessage(r), observations: r.errores });
    }
    if (r.resultado === "A" || r.resultado === "O") {
      const obs = r.observaciones.length > 0 ? r.observaciones : null;
      if (r.datosEmision) return update(admin, rem.id, { cod_remito: r.codRemito, observations: obs, ...emittedFields(r.datosEmision, r.qr, r.estado) });
      return update(admin, rem.id, {
        status: "generado",
        cod_remito: r.codRemito,
        arca_estado: r.estado,
        observations: obs,
        error_message: "ARCA lo generó pero todavía no está emitido (puede faltar la autorización del titular o del depositario, o emitirlo)."
      });
    }
    return update(admin, rem.id, { status: "incierto", error_message: "Respuesta de ARCA que no se entendió. Antes de reintentar se le pregunta si lo recibió." });
  } catch (err) {
    const message = err instanceof Error ? err.message : "No se pudo hablar con ARCA.";
    // Si nunca salió el pedido, sigue pendiente; si salió, incierto.
    const { data: now } = await admin.from("rec_remitos").select("sent_at").eq("id", rem.id).maybeSingle();
    await update(admin, rem.id, { status: now?.sent_at ? "incierto" : "pendiente", error_message: message });
    throw err;
  }
}

async function refresh(admin: SupabaseClient, companyId: string, remitoId: string): Promise<Row> {
  const rem = await loadRemito(admin, companyId, remitoId);
  if (!rem.cod_remito) {
    if (rem.status === "incierto" || (rem.status === "pendiente" && rem.sent_at)) return send(admin, companyId, remitoId);
    return rem;
  }
  const auth = await authFor(admin, companyId);
  const xml = await ws({ admin, companyId, remitoId }, "consultarRemito", auth, consultarRemitoPorCodigoInner(rem.cod_remito));
  const c = xml ? parseConsultaRemito(xml) : null;
  if (!c || !c.found) throw new UserError(c ? friendlyRemcarneMessage({ errores: c.errores, fault: c.fault }) : "ARCA no respondió.");
  if (c.datosEmision) {
    const fields = emittedFields(c.datosEmision, c.qr, c.estado);
    // Un remito ya emitido conserva su fecha de emisión original; solo cambia el estado.
    return update(admin, rem.id, rem.status === "emitido" ? { arca_estado: c.estado, ...(c.qr ? { qr_base64: c.qr } : {}) } : fields);
  }
  return update(admin, rem.id, { arca_estado: c.estado });
}

async function emit(admin: SupabaseClient, companyId: string, remitoId: string): Promise<Row> {
  const current = await loadRemito(admin, companyId, remitoId);
  if (current.status !== "generado" || !current.cod_remito) throw new UserError("Solo se emite un remito que ARCA ya generó.");
  const rem = await claim(admin, current, ["generado"]);
  if (!rem) throw new UserError("Ese remito se está mandando en este momento.");
  const auth = await authFor(admin, companyId);
  const xml = await ws({ admin, companyId, remitoId }, "emitirRemito", auth, emitirRemitoInner(rem.cod_remito));
  if (!xml) {
    await update(admin, rem.id, { error_message: "ARCA no respondió al emitir. Tocá \"Consultar en ARCA\" antes de reintentar." });
    return refresh(admin, companyId, remitoId).catch(() => loadRemito(admin, companyId, remitoId));
  }
  const r = parseRemitoReturn(xml);
  if (r.datosEmision && r.resultado !== "R") return update(admin, rem.id, emittedFields(r.datosEmision, r.qr, r.estado));
  return update(admin, rem.id, { arca_estado: r.estado ?? rem.arca_estado, error_message: friendlyRemcarneMessage(r) });
}

async function voidRemito(admin: SupabaseClient, companyId: string, userId: string, role: string, remitoId: string): Promise<Row> {
  if (role !== "owner" && role !== "admin") throw new UserError("Solo el dueño o un administrador anula remitos.");
  const rem = await loadRemito(admin, companyId, remitoId);
  if (rem.status !== "generado" || !rem.cod_remito) {
    throw new UserError("ARCA solo deja anular un remito generado que todavía no se emitió. Uno emitido lo rechaza el destinatario en ARCA.");
  }
  const auth = await authFor(admin, companyId);
  const xml = await ws({ admin, companyId, remitoId }, "anularRemito", auth, anularRemitoInner(rem.cod_remito));
  if (!xml) throw new UserError("ARCA no respondió. Consultá el remito antes de volver a anularlo.");
  const r = parseRemitoReturn(xml);
  if (r.resultado === "A" || r.resultado === "O") {
    await admin.from("audit_log").insert({ company_id: companyId, user_id: userId, action: "rec.void", entity_type: "rec_remito", entity_id: remitoId, new_data: { cod_remito: rem.cod_remito } });
    return update(admin, rem.id, { status: "anulado", error_message: null });
  }
  throw new UserError(friendlyRemcarneMessage(r));
}

async function domicilios(admin: SupabaseClient, companyId: string, cuit: string) {
  const clean = String(cuit ?? "").replace(/\D/g, "");
  if (clean.length !== 11) throw new UserError("CUIT inválido.");
  const auth = await authFor(admin, companyId);
  const xml = await ws({ admin, companyId }, "consultarCodigosDomicilio", auth, consultarCodigosDomicilioInner(clean));
  if (!xml) throw new UserError("ARCA no respondió.");
  const r = parseLista(xml, "arrayDomicilios");
  if (r.fault || (r.items.length === 0 && r.errores.length > 0)) throw new UserError(friendlyRemcarneMessage({ errores: r.errores, fault: r.fault }));
  return { items: r.items };
}

const publicRow = (r: Row) => ({ ...r, qr_base64: r.qr_base64 ? true : false });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método no permitido" }, 405);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  try {
    const body = await req.json().catch(() => ({}));
    const who = await caller(req, admin);
    const canIssue = ["owner", "admin", "manager", "production"].includes(who.role);
    const id = typeof body.remitoId === "string" ? body.remitoId : "";
    switch (body.action) {
      case "check":
        if (who.role !== "owner" && who.role !== "admin") throw new UserError("Solo el dueño o un administrador prueba la conexión.");
        return jsonResponse(await checkConnection(admin, who.companyId, who.userId));
      case "domicilios":
        if (!canIssue) throw new UserError("No tenés permiso.");
        return jsonResponse(await domicilios(admin, who.companyId, String(body.cuit ?? "")));
      case "send":
        if (!canIssue) throw new UserError("No tenés permiso para emitir remitos.");
        return jsonResponse({ env: ARCA_ENV, remito: publicRow(await send(admin, who.companyId, id)) });
      case "emit":
        if (!canIssue) throw new UserError("No tenés permiso para emitir remitos.");
        return jsonResponse({ env: ARCA_ENV, remito: publicRow(await emit(admin, who.companyId, id)) });
      case "refresh":
        if (!canIssue) throw new UserError("No tenés permiso.");
        return jsonResponse({ env: ARCA_ENV, remito: publicRow(await refresh(admin, who.companyId, id)) });
      case "void":
        return jsonResponse({ env: ARCA_ENV, remito: publicRow(await voidRemito(admin, who.companyId, who.userId, who.role, id)) });
      default:
        return jsonResponse({ error: "Acción desconocida" }, 400);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error inesperado";
    if (!(err instanceof UserError)) console.error("arca-remito", err);
    return jsonResponse({ error: message });
  }
});
