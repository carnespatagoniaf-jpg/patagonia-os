// Factura electrónica ARCA: pide el CAE de cada factura o nota de crédito
// pendiente (tabla invoices, migraciones 113, 136 y 137).
//
// Con qué certificado se factura (migración 137, como TusFacturas):
// - Cada negocio tiene SU certificado (arca_company_certificates). La función
//   genera la clave y el pedido (CSR) para el CUIT del negocio; el negocio lo
//   sube en su ARCA, baja el certificado, lo sube en Facturas y le da a ese
//   certificado la relación "Facturación Electrónica". Ningún CUIT de Patagonia
//   queda en el ARCA del cliente. La clave privada se guarda cifrada (AES-GCM,
//   secreto ARCA_VAULT_KEY).
// - Carnes Patagonia (CUIT del certificado de los secretos ARCA_KEY/ARCA_CERT)
//   factura con ese certificado compartido, que es de su propio CUIT.
// El ticket del WSAA (12 h) es por certificado: se guarda por huella del certificado.
//
// Acciones (POST JSON):
//   { action: "check" }                    dueño/administrador: prueba la conexión
//                                          y, si da bien, activa la factura (enabled).
//   { action: "authorize", invoiceId? }    cualquiera de la empresa: pide el CAE de
//                                          esa factura, o de las pendientes (hasta 10).
//   { action: "cert_status" }              dueño/administrador: estado del certificado.
//   { action: "cert_request", regenerate? } dueño/administrador: genera clave + pedido (CSR).
//   { action: "cert_upload", pem }         dueño/administrador: guarda el certificado bajado de ARCA.
//
// Secretos (Supabase → Edge Functions → Secrets), nunca llegan al navegador:
//   ARCA_ENV        "homo" (staging, ARCA de prueba) o "prod" (producción)
//   ARCA_KEY        clave privada PEM del certificado compartido (C:\Users\g\patagonia-arca)
//   ARCA_CERT       certificado compartido PEM (homo: prueba2.crt, prod: real.crt)
//   ARCA_VAULT_KEY  32 bytes en base64 para cifrar las claves de cada negocio
//
// Nunca se duplica un número: antes de pedir se guarda el número en
// pending_number; si la respuesta se pierde, el reintento primero le pregunta a
// ARCA (FECompConsultar) si ese número quedó autorizado con este importe.
//
// Deploy: npx supabase functions deploy arca-invoice --project-ref <ref>

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import forge from "npm:node-forge@1.3.1";
import {
  ARCA_ENDPOINTS,
  arDate,
  caeRequestInner,
  certificateProblem,
  consultIsUncertain,
  consultInner,
  friendlyArcaMessage,
  isNumberRaceError,
  isoFromArcaDate,
  lastAuthorizedInner,
  loginTicketRequestXml,
  parseCaeResponse,
  parseVatLines,
  parseConsultResponse,
  parseLastAuthorized,
  parseLoginResponse,
  parsePointsOfSale,
  wsaaLoginEnvelope,
  wsfeEnvelope,
  type ArcaAuth,
  type ArcaEnv
} from "./voucher.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ARCA_ENV: ArcaEnv = Deno.env.get("ARCA_ENV") === "prod" ? "prod" : "homo";
const ARCA_KEY = (Deno.env.get("ARCA_KEY") ?? "").replace(/\\n/g, "\n");
const ARCA_CERT = (Deno.env.get("ARCA_CERT") ?? "").replace(/\\n/g, "\n");
const ARCA_VAULT_KEY = Deno.env.get("ARCA_VAULT_KEY") ?? "";
const ENDPOINTS = ARCA_ENDPOINTS[ARCA_ENV];
/** Alias con el que el negocio da de alta el certificado en su ARCA. */
const COMPANY_CERT_ALIAS = "patagonia";
/**
 * Únicas empresas que pueden facturar con el certificado compartido (el CUIT es de Carnes Patagonia).
 * Antes bastaba con cargar ese CUIT en Facturas: cualquier cliente podía sacar CAE a nombre de Carnes Patagonia
 * (auditoría 29/10/2026, crítico C2). Producción: Carnes Patagonia. Homologación (staging): Carnicería Don Julio.
 */
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

// ---------- certificados ----------

interface Credentials {
  keyPem: string;
  certPem: string;
  /** Huella SHA-256 del certificado: el ticket del WSAA se guarda por certificado. */
  fingerprint: string;
  /** true = certificado compartido (Carnes Patagonia); false = el del negocio. */
  shared: boolean;
}

function fingerprintOf(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return forge.md.sha256.create().update(der).digest().toHex();
}

/** "CUIT 27182448902" → "27182448902" (atributo serialNumber del sujeto). */
function cuitOf(cert: forge.pki.Certificate): string {
  const field = cert.subject.attributes.find((a) => a.type === "2.5.4.5");
  return String(field?.value ?? "").replace(/\D/g, "");
}

let sharedCache: { cert: forge.pki.Certificate; fingerprint: string; cuit: string } | null = null;
function sharedCertificate() {
  if (!ARCA_CERT) return null;
  if (!sharedCache) {
    const cert = forge.pki.certificateFromPem(ARCA_CERT);
    sharedCache = { cert, fingerprint: fingerprintOf(cert), cuit: cuitOf(cert) };
  }
  return sharedCache;
}

async function vaultKey(): Promise<CryptoKey> {
  if (!ARCA_VAULT_KEY) throw new Error("Falta el secreto ARCA_VAULT_KEY en la Edge Function.");
  const raw = Uint8Array.from(atob(ARCA_VAULT_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function encryptKey(pem: string): Promise<{ cipher: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await vaultKey(), new TextEncoder().encode(pem)));
  return { cipher: toB64(cipher), iv: toB64(iv) };
}

async function decryptKey(cipher: string, iv: string): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await vaultKey(), fromB64(cipher));
  return new TextDecoder().decode(plain);
}

/** Con qué certificado factura este negocio: el suyo; si no tiene y es el CUIT del compartido, el compartido. */
async function credentialsFor(admin: SupabaseClient, companyId: string, cuit: string): Promise<Credentials> {
  const { data: own } = await admin.from("arca_company_certificates").select("*").eq("company_id", companyId).maybeSingle();
  if (own?.cert_pem) {
    if (own.cuit !== cuit) throw new UserError("El certificado cargado es de otro CUIT. Generá uno nuevo en Facturas → Conectar con ARCA.");
    return { keyPem: await decryptKey(own.key_cipher, own.key_iv), certPem: own.cert_pem, fingerprint: own.cert_fingerprint, shared: false };
  }
  const shared = sharedCertificate();
  if (shared && shared.cuit === cuit && ARCA_KEY && SHARED_CERT_COMPANIES[ARCA_ENV].includes(companyId)) {
    return { keyPem: ARCA_KEY, certPem: ARCA_CERT, fingerprint: shared.fingerprint, shared: true };
  }
  throw new UserError("Falta el certificado de ARCA de este negocio: hacé los pasos de Facturas → Conectar con ARCA.");
}

async function generateCsr(cuit: string, businessName: string): Promise<{ csrPem: string; keyPem: string }> {
  // La clave se genera con WebCrypto (rápido, fuera del límite de CPU) y se firma el pedido con forge.
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const privateKey = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(forge.util.binary.raw.encode(pkcs8))) as forge.pki.rsa.PrivateKey;
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = publicKey;
  csr.setSubject([
    { name: "countryName", value: "AR" },
    { name: "organizationName", value: businessName.slice(0, 60) || "Patagonia OS" },
    { name: "commonName", value: COMPANY_CERT_ALIAS },
    { type: "2.5.4.5", value: `CUIT ${cuit}` }
  ]);
  csr.sign(privateKey, forge.md.sha256.create());
  return { csrPem: forge.pki.certificationRequestToPem(csr), keyPem: forge.pki.privateKeyToPem(privateKey) };
}

// ---------- WSAA: ticket de acceso (12 h), guardado en arca_access_tickets ----------

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

async function readTicket(admin: SupabaseClient, creds: Credentials): Promise<{ token: string; sign: string } | null> {
  const { data } = await admin
    .from("arca_access_tickets")
    .select("token,sign,expires_at")
    .eq("env", ARCA_ENV)
    .eq("service", "wsfe")
    .eq("cert_key", creds.fingerprint)
    .maybeSingle();
  if (!data) return null;
  // Margen de 5 minutos para no usar uno que vence en el medio de un pedido.
  if (new Date(data.expires_at).getTime() - Date.now() < 5 * 60_000) return null;
  return { token: data.token, sign: data.sign };
}

async function accessTicket(admin: SupabaseClient, creds: Credentials): Promise<{ token: string; sign: string }> {
  const cached = await readTicket(admin, creds);
  if (cached) return cached;

  const res = await fetch(ENDPOINTS.wsaa, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' },
    body: wsaaLoginEnvelope(signLoginRequest(loginTicketRequestXml(new Date()), creds)),
    signal: AbortSignal.timeout(20_000)
  });
  const parsed = parseLoginResponse(await res.text());
  if ("fault" in parsed) {
    // Otro pedido (otra caja) sacó el ticket recién: ARCA no da otro hasta que venza.
    if (/ya posee un TA valido/i.test(parsed.fault)) {
      await new Promise((r) => setTimeout(r, 1500));
      const again = await readTicket(admin, creds);
      if (again) return again;
      throw new Error("ARCA ya entregó un permiso de conexión que todavía no venció (dura 12 horas) y no quedó guardado acá. Se libera solo; probá más tarde.");
    }
    if (/no autorizado|not authorized|computador/i.test(parsed.fault) && !creds.shared) {
      throw new UserError(`ARCA no deja usar el certificado para facturar: falta darle la relación "Facturación Electrónica" en tu ARCA (paso 4). Detalle: ${parsed.fault}`);
    }
    throw new Error(`ARCA no aceptó el certificado: ${parsed.fault}`);
  }
  await admin.from("arca_access_tickets").upsert({
    env: ARCA_ENV,
    service: "wsfe",
    cert_key: creds.fingerprint,
    token: parsed.token,
    sign: parsed.sign,
    expires_at: parsed.expiresAt,
    updated_at: new Date().toISOString()
  });
  return { token: parsed.token, sign: parsed.sign };
}

// ---------- WSFEv1 ----------

async function wsfe(method: string, auth: ArcaAuth, inner = ""): Promise<string> {
  const res = await fetch(ENDPOINTS.wsfe, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"http://ar.gov.afip.dif.FEV1/${method}"` },
    body: wsfeEnvelope(method, auth, inner),
    signal: AbortSignal.timeout(25_000)
  });
  const text = await res.text();
  if (!res.ok && !text.includes("<soap:Envelope")) throw new Error(`ARCA respondió ${res.status} en ${method}`);
  return text;
}

async function lastAuthorized(auth: ArcaAuth, pointOfSale: number, voucherType: number): Promise<number> {
  const r = parseLastAuthorized(await wsfe("FECompUltimoAutorizado", auth, lastAuthorizedInner(pointOfSale, voucherType)));
  if (r.errors.length > 0 || r.number === null) throw new UserError(friendlyArcaMessage(r.errors));
  return r.number;
}

// ---------- quién llama ----------

async function caller(req: Request, admin: SupabaseClient) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData } = await userClient.auth.getUser();
  const user = userData?.user;
  if (!user) throw new UserError("Sesión vencida: volvé a entrar.");
  const { data: profile } = await admin.from("profiles").select("company_id,role,active").eq("id", user.id).maybeSingle();
  if (!profile?.active || !profile.company_id) throw new UserError("Perfil inválido.");
  const { data: company } = await admin.from("companies").select("active,plan").eq("id", profile.company_id).maybeSingle();
  if (!company?.active) throw new UserError("La empresa está desactivada.");
  if (company.plan === "basico") throw new UserError("La factura electrónica está en los planes Estándar y Full.");
  return { userId: user.id as string, companyId: profile.company_id as string, role: profile.role as string };
}

async function fiscalSettings(admin: SupabaseClient, companyId: string): Promise<Row | null> {
  const { data } = await admin.from("company_fiscal_settings").select("*").eq("company_id", companyId).maybeSingle();
  return data;
}

// ---------- "Probar conexión con ARCA" ----------

async function checkConnection(admin: SupabaseClient, companyId: string, userId: string) {
  const settings = await fiscalSettings(admin, companyId);
  if (!settings) throw new UserError("Primero guardá los datos fiscales del negocio.");
  const save = async (ok: boolean, message: string) => {
    await admin
      .from("company_fiscal_settings")
      .update({ enabled: ok, last_check_at: new Date().toISOString(), last_check_ok: ok, last_check_message: message })
      .eq("company_id", companyId);
    await admin.from("audit_log").insert({ company_id: companyId, user_id: userId, action: "fiscal.check", entity_type: "company", entity_id: companyId, new_data: { ok, message, env: ARCA_ENV } });
    return { ok, message, env: ARCA_ENV };
  };

  try {
    const ticket = await accessTicket(admin, await credentialsFor(admin, companyId, settings.cuit));
    const auth: ArcaAuth = { ...ticket, cuit: settings.cuit };
    // En el ARCA de prueba no hay puntos de venta reales: se salta ese control.
    if (ARCA_ENV === "prod") {
      const pv = parsePointsOfSale(await wsfe("FEParamGetPtosVenta", auth));
      const realErrors = pv.errors.filter((e) => e.code !== 602);
      if (realErrors.length > 0) return save(false, friendlyArcaMessage(realErrors));
      const point = pv.points.find((p) => p.number === Number(settings.point_of_sale));
      if (!point) {
        const list = pv.points.filter((p) => !p.closed).map((p) => p.number).join(", ");
        return save(false, `En ARCA no hay un punto de venta ${settings.point_of_sale} para web services${list ? ` (tenés: ${list})` : ""}. Crealo como "RECE para aplicativo y web services" o corregí el número.`);
      }
      if (point.closed || point.blocked) return save(false, `El punto de venta ${settings.point_of_sale} está dado de baja o bloqueado en ARCA.`);
    }
    const mainType = settings.tax_condition === "monotributo" ? 11 : 6;
    const last = await lastAuthorized(auth, Number(settings.point_of_sale), mainType);
    const letter = mainType === 11 ? "C" : "B";
    return save(true, `Conectado con ARCA${ARCA_ENV === "homo" ? " (ambiente de PRUEBA)" : ""}. Última Factura ${letter} del punto de venta ${settings.point_of_sale}: ${last}.`);
  } catch (err) {
    return save(false, err instanceof Error ? err.message : "No se pudo conectar con ARCA.");
  }
}

// ---------- pedir el CAE ----------

interface Outcome {
  id: string;
  status: string;
  letter: string;
  kind: string;
  number: number | null;
  cae: string | null;
  caeDue: string | null;
  message: string | null;
}

const outcome = (inv: Row, message: string | null = null): Outcome => ({
  id: inv.id,
  status: inv.status,
  letter: inv.letter,
  kind: inv.kind,
  number: inv.number === null ? null : Number(inv.number),
  cae: inv.cae,
  caeDue: inv.cae_due,
  message: message ?? inv.error_message
});

async function update(admin: SupabaseClient, id: string, fields: Record<string, unknown>): Promise<Row> {
  const { data, error } = await admin.from("invoices").update(fields).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

/** Nota de crédito automática cuando la venta ya estaba anulada al autorizarse su factura. */
async function queueCreditNoteIfSaleVoided(admin: SupabaseClient, inv: Row): Promise<Row | null> {
  if (inv.kind !== "factura" || inv.status !== "autorizada" || !inv.pos_sale_id) return null;
  const { data: sale } = await admin.from("pos_sales").select("voided_at").eq("id", inv.pos_sale_id).maybeSingle();
  if (!sale?.voided_at) return null;
  const { data: existing } = await admin.from("invoices").select("id").eq("related_invoice_id", inv.id).eq("kind", "nota_credito").neq("status", "rechazada").maybeSingle();
  if (existing) return null;
  const { data } = await admin.rpc("arca_queue_credit_note", { p_invoice_id: inv.id });
  if (!data) return null;
  const { data: nc } = await admin.from("invoices").select("*").eq("id", data).maybeSingle();
  return nc;
}

async function authorizeOne(admin: SupabaseClient, settings: Row, invoiceId: string): Promise<Outcome[]> {
  // Una corrida con ARCA lenta puede pasar los 2 minutos (WSAA + consulta + 3 intentos): con 120 s otra caja
  // podía tomar la misma factura a mitad de camino y pedir otro número (auditoría 29/10/2026). 5 minutos.
  const cutoff = new Date(Date.now() - 300_000).toISOString();
  const { data: current } = await admin.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
  if (!current) throw new UserError("Factura inexistente.");
  if (current.status !== "pendiente") return [outcome(current)];

  // Se "toma" la factura para que dos cajas no pidan el mismo CAE a la vez.
  const { data: claimed } = await admin
    .from("invoices")
    .update({ claimed_at: new Date().toISOString(), attempts: Number(current.attempts ?? 0) + 1 })
    .eq("id", invoiceId)
    .eq("status", "pendiente")
    .or(`claimed_at.is.null,claimed_at.lt.${cutoff}`)
    .select()
    .maybeSingle();
  if (!claimed) return [outcome(current, "Se está pidiendo en este momento desde otra caja.")];
  let inv: Row = claimed;

  const ticket = await accessTicket(admin, await credentialsFor(admin, settings.company_id, settings.cuit));
  const auth: ArcaAuth = { ...ticket, cuit: settings.cuit };
  const pv = Number(inv.point_of_sale);
  const type = Number(inv.voucher_type);

  // 1) ¿Un intento anterior quedó autorizado aunque no llegó la respuesta?
  if (inv.pending_number) {
    const c = parseConsultResponse(await wsfe("FECompConsultar", auth, consultInner(pv, type, Number(inv.pending_number))));
    const sameDoc = String(c.docNumber ?? "") === String(inv.customer_doc_number ?? "0");
    if (c.found && c.cae && c.total !== null && Math.abs(c.total - Number(inv.total)) < 0.01 && sameDoc) {
      inv = await update(admin, inv.id, {
        status: "autorizada",
        number: inv.pending_number,
        cae: c.cae,
        cae_due: c.caeDue,
        issued_on: c.date ? isoFromArcaDate(c.date) : null,
        authorized_at: new Date().toISOString(),
        pending_number: null,
        claimed_at: null,
        error_message: null
      });
      const nc = await queueCreditNoteIfSaleVoided(admin, inv);
      return nc ? [outcome(inv), ...(await authorizeOne(admin, settings, nc.id))] : [outcome(inv)];
    }
    // ARCA no dijo que ese número no existe: no se pide otro (podría quedar duplicada). Queda pendiente.
    if (consultIsUncertain(c)) {
      inv = await update(admin, inv.id, { error_message: "ARCA no pudo confirmar el intento anterior. Se vuelve a intentar sola.", claimed_at: null });
      return [outcome(inv)];
    }
  }

  // 2) Factura de una venta que se anuló o borró antes de llegar a ARCA: no se emite.
  if (inv.kind === "factura") {
    let gone = !inv.pos_sale_id && !inv.customer_charge_id;
    if (inv.pos_sale_id) {
      const { data: sale } = await admin.from("pos_sales").select("voided_at").eq("id", inv.pos_sale_id).maybeSingle();
      gone = !sale || Boolean(sale.voided_at);
    }
    if (gone) {
      inv = await update(admin, inv.id, { status: "rechazada", error_message: "La venta se anuló antes de facturarse: no se emitió.", pending_number: null, claimed_at: null });
      return [outcome(inv)];
    }
  }

  // 3) Nota de crédito: necesita los datos de la factura que anula.
  let related: { voucherType: number; pointOfSale: number; number: number; cuit: string; date: string } | undefined;
  if (inv.kind === "nota_credito") {
    const { data: original } = await admin.from("invoices").select("*").eq("id", inv.related_invoice_id).maybeSingle();
    if (!original || original.status !== "autorizada") {
      inv = await update(admin, inv.id, { status: "rechazada", error_message: "La factura que anula no está autorizada.", claimed_at: null });
      return [outcome(inv)];
    }
    related = {
      voucherType: Number(original.voucher_type),
      pointOfSale: Number(original.point_of_sale),
      number: Number(original.number),
      cuit: settings.cuit,
      date: String(original.issued_on ?? original.authorized_at ?? original.created_at).slice(0, 10).replace(/-/g, "")
    };
  }

  // 4) Pedir el CAE con el número siguiente (si otra caja ganó ese número, se reintenta).
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = (await lastAuthorized(auth, pv, type)) + 1;
    const date = arDate(new Date());
    inv = await update(admin, inv.id, { pending_number: next });
    let xml: string;
    try {
      xml = await wsfe(
        "FECAESolicitar",
        auth,
        caeRequestInner({
          pointOfSale: pv,
          voucherType: type,
          number: next,
          date,
          docType: Number(inv.customer_doc_type),
          docNumber: String(inv.customer_doc_number ?? "0"),
          receiverCondition: inv.customer_tax_condition,
          total: Number(inv.total),
          net: Number(inv.net),
          vat: Number(inv.vat),
          vatRate: Number(inv.vat_rate),
          vatLines: parseVatLines(inv.vat_breakdown),
          related
        })
      );
    } catch {
      // Sin respuesta: queda pendiente con su número guardado; el reintento consulta antes de volver a pedir.
      inv = await update(admin, inv.id, { error_message: "ARCA no respondió. Se vuelve a intentar sola." });
      return [outcome(inv)];
    }
    const r = parseCaeResponse(xml);
    if (r.result === "A" && r.cae) {
      inv = await update(admin, inv.id, {
        status: "autorizada",
        number: r.number ?? next,
        cae: r.cae,
        cae_due: r.caeDue,
        issued_on: isoFromArcaDate(r.date ?? date),
        authorized_at: new Date().toISOString(),
        pending_number: null,
        claimed_at: null,
        error_message: r.observations.length > 0 ? friendlyArcaMessage([], r.observations) : null
      });
      const nc = await queueCreditNoteIfSaleVoided(admin, inv);
      return nc ? [outcome(inv), ...(await authorizeOne(admin, settings, nc.id))] : [outcome(inv)];
    }
    if (isNumberRaceError(r.errors)) continue;
    inv = await update(admin, inv.id, {
      status: "rechazada",
      error_message: friendlyArcaMessage(r.errors, r.observations),
      pending_number: null,
      claimed_at: null
    });
    return [outcome(inv)];
  }
  inv = await update(admin, inv.id, { error_message: "Otra caja estaba facturando al mismo tiempo. Se vuelve a intentar sola.", claimed_at: null });
  return [outcome(inv)];
}

async function authorize(admin: SupabaseClient, companyId: string, invoiceId: string | undefined) {
  const settings = await fiscalSettings(admin, companyId);
  if (!settings?.enabled) throw new UserError("La factura electrónica no está activada en este negocio.");
  let ids: string[];
  if (invoiceId) {
    const { data } = await admin.from("invoices").select("id").eq("id", invoiceId).eq("company_id", companyId).maybeSingle();
    if (!data) throw new UserError("Factura inexistente.");
    ids = [data.id];
  } else {
    const { data } = await admin.from("invoices").select("id").eq("company_id", companyId).eq("status", "pendiente").order("created_at").limit(10);
    ids = (data ?? []).map((r: Row) => r.id);
  }
  const results: Outcome[] = [];
  for (const id of ids) {
    try {
      results.push(...(await authorizeOne(admin, settings, id)));
    } catch (err) {
      // Error de conexión o de ticket: la factura sigue pendiente y se reintenta después.
      const message = err instanceof Error ? err.message : "No se pudo hablar con ARCA.";
      await admin.from("invoices").update({ error_message: message, claimed_at: null }).eq("id", id).eq("status", "pendiente");
      const { data } = await admin.from("invoices").select("*").eq("id", id).maybeSingle();
      if (data) results.push(outcome(data, message));
    }
  }
  return { env: ARCA_ENV, results };
}

// ---------- certificado propio del negocio ----------

async function certStatus(admin: SupabaseClient, companyId: string) {
  const settings = await fiscalSettings(admin, companyId);
  const shared = sharedCertificate();
  const { data: own } = await admin
    .from("arca_company_certificates")
    .select("cuit,alias,csr_pem,cert_pem,cert_expires_at,updated_at")
    .eq("company_id", companyId)
    .maybeSingle();
  const cuit = settings?.cuit ?? null;
  return {
    env: ARCA_ENV,
    alias: COMPANY_CERT_ALIAS,
    /** Carnes Patagonia: factura con el certificado compartido, que es de su CUIT; no tiene que hacer nada. */
    usesShared: Boolean(cuit && shared && shared.cuit === cuit && !own?.cert_pem && SHARED_CERT_COMPANIES[ARCA_ENV].includes(companyId)),
    hasRequest: Boolean(own && own.cuit === cuit),
    csrPem: own && own.cuit === cuit ? own.csr_pem : null,
    hasCertificate: Boolean(own?.cert_pem && own.cuit === cuit),
    certExpiresAt: own?.cert_pem && own.cuit === cuit ? own.cert_expires_at : null
  };
}

async function certRequest(admin: SupabaseClient, companyId: string, userId: string, regenerate: boolean) {
  const settings = await fiscalSettings(admin, companyId);
  if (!settings) throw new UserError("Primero guardá los datos fiscales del negocio (el CUIT va en el certificado).");
  const { data: own } = await admin.from("arca_company_certificates").select("cuit,csr_pem,cert_pem").eq("company_id", companyId).maybeSingle();
  // El mismo pedido sirve hasta que se suba el certificado: así no se invalida uno que el cliente ya cargó en ARCA.
  if (own && own.cuit === settings.cuit && !regenerate) return { csrPem: own.csr_pem, alias: COMPANY_CERT_ALIAS };
  const { csrPem, keyPem } = await generateCsr(settings.cuit, settings.business_name ?? "");
  const { cipher, iv } = await encryptKey(keyPem);
  const { error } = await admin.from("arca_company_certificates").upsert({
    company_id: companyId,
    cuit: settings.cuit,
    alias: COMPANY_CERT_ALIAS,
    csr_pem: csrPem,
    key_cipher: cipher,
    key_iv: iv,
    cert_pem: null,
    cert_fingerprint: null,
    cert_expires_at: null,
    updated_at: new Date().toISOString()
  });
  if (error) throw error;
  if (own?.cert_pem) {
    // Había un certificado: se reemplaza por el nuevo pedido, hasta subir el nuevo no se factura.
    await admin.from("company_fiscal_settings").update({ enabled: false }).eq("company_id", companyId);
  }
  await admin.from("audit_log").insert({ company_id: companyId, user_id: userId, action: "fiscal.cert_request", entity_type: "company", entity_id: companyId, new_data: { cuit: settings.cuit, env: ARCA_ENV } });
  return { csrPem, alias: COMPANY_CERT_ALIAS };
}

async function certUpload(admin: SupabaseClient, companyId: string, userId: string, rawPem: string) {
  const settings = await fiscalSettings(admin, companyId);
  if (!settings) throw new UserError("Primero guardá los datos fiscales del negocio.");
  const { data: own } = await admin.from("arca_company_certificates").select("*").eq("company_id", companyId).maybeSingle();
  if (!own) throw new UserError("Primero generá el pedido de certificado (paso 1).");
  let text = String(rawPem ?? "").trim();
  if (!text.includes("BEGIN CERTIFICATE")) text = `-----BEGIN CERTIFICATE-----\n${text.replace(/\s+/g, "")}\n-----END CERTIFICATE-----`;
  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromPem(text);
  } catch {
    throw new UserError("Ese archivo no es un certificado. Subí el que bajaste de ARCA con el botón Descargar (termina en .crt).");
  }
  const key = forge.pki.privateKeyFromPem(await decryptKey(own.key_cipher, own.key_iv)) as forge.pki.rsa.PrivateKey;
  const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
  const issuerCn = String(cert.issuer.getField("CN")?.value ?? "");
  const problem = certificateProblem({
    env: ARCA_ENV,
    issuerCommonName: issuerCn,
    subjectCuit: cuitOf(cert),
    expectedCuit: settings.cuit,
    notAfter: cert.validity.notAfter,
    now: new Date(),
    keyMatches: publicKey.n.equals(key.n) && publicKey.e.equals(key.e)
  });
  if (problem) throw new UserError(problem);
  const pem = forge.pki.certificateToPem(cert);
  const { error } = await admin
    .from("arca_company_certificates")
    .update({ cert_pem: pem, cert_fingerprint: fingerprintOf(cert), cert_expires_at: cert.validity.notAfter.toISOString(), updated_at: new Date().toISOString() })
    .eq("company_id", companyId);
  if (error) throw error;
  await admin.from("audit_log").insert({ company_id: companyId, user_id: userId, action: "fiscal.cert_upload", entity_type: "company", entity_id: companyId, new_data: { cuit: settings.cuit, expires: cert.validity.notAfter.toISOString(), env: ARCA_ENV } });
  return { ok: true, certExpiresAt: cert.validity.notAfter.toISOString() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método no permitido" }, 405);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  try {
    const body = await req.json().catch(() => ({}));
    const who = await caller(req, admin);
    if (body.action === "check") {
      if (who.role !== "owner" && who.role !== "admin") throw new UserError("Solo el dueño o un administrador prueba la conexión.");
      return jsonResponse(await checkConnection(admin, who.companyId, who.userId));
    }
    if (body.action === "authorize") {
      return jsonResponse(await authorize(admin, who.companyId, typeof body.invoiceId === "string" ? body.invoiceId : undefined));
    }
    if (body.action === "cert_status" || body.action === "cert_request" || body.action === "cert_upload") {
      if (who.role !== "owner" && who.role !== "admin") throw new UserError("Solo el dueño o un administrador maneja el certificado de ARCA.");
      if (body.action === "cert_status") return jsonResponse(await certStatus(admin, who.companyId));
      if (body.action === "cert_request") return jsonResponse(await certRequest(admin, who.companyId, who.userId, body.regenerate === true));
      return jsonResponse(await certUpload(admin, who.companyId, who.userId, String(body.pem ?? "")));
    }
    return jsonResponse({ error: "Acción desconocida" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error inesperado";
    if (!(err instanceof UserError)) console.error("arca-invoice", err);
    // 200 con error: así supabase-js le entrega el texto a la pantalla.
    return jsonResponse({ error: message });
  }
});

