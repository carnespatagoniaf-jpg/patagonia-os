// "Leer factura con foto" (Compras). Recibe la foto (o el PDF) de una factura,
// remito o boleta de un proveedor y devuelve sus datos ordenados: proveedor,
// CUIT, fecha, número, renglones y total. NO guarda nada: la web completa el
// formulario de compra y la persona revisa y confirma con "Registrar compra".
//
// No lee datos del negocio (ni productos ni proveedores): solo la imagen que
// manda la persona. El emparejamiento con los productos y proveedores de la
// empresa lo hace la web (invoice-draft.ts), con lo que ya tiene cargado.
//
// Secreto necesario: ANTHROPIC_API_KEY (el mismo del chat de ayuda).
// Se despliega sola desde GitHub (publicar.yml despliega todas las funciones).

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const MODEL = "claude-opus-5-5";
const DAILY_LIMIT_PER_COMPANY = 60;
// Base64 de ~9 MB = archivo de ~6,7 MB. La web achica las fotos antes de mandarlas.
const MAX_BASE64_CHARS = 9_000_000;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
const PURCHASE_ROLES = ["owner", "admin", "manager"];

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

const INSTRUCTIONS = `Leés comprobantes de compra de carnicerías argentinas: facturas A/B/C, remitos, boletas, tickets y notas de pedido de proveedores (frigoríficos, avícolas, distribuidoras, almacén). Extraé los datos tal como figuran en el papel.

Reglas:
- supplier_name: el nombre del que VENDE (el emisor del comprobante, normalmente arriba), no el del cliente/comprador.
- supplier_tax_id: el CUIT del emisor, solo dígitos (11). Vacío si no figura.
- date: la fecha del comprobante en formato AAAA-MM-DD. Vacío si no se lee.
- invoice_number: el número del comprobante tal como figura (ej. "0003-00012345"). Vacío si no figura.
- items: un renglón por cada producto. description = el texto del renglón tal cual. quantity = la cantidad (kilos si se vende por kilo, unidades si no). unit = "kg" si la cantidad son kilos, "unit" si son unidades, cajas, bultos o piezas sin peso. unit_price = el precio por kg o por unidad SIN IVA si el comprobante discrimina IVA, si no el que figura. line_total = el importe del renglón que figura en el papel (sin IVA si se discrimina).
- Si un renglón da cajas y también kilos (ej. "2 cajas 38,5 kg"), usá los kilos y unit "kg".
- Números: en Argentina el punto separa miles y la coma decimales ("1.234,50" = 1234.5). Devolvé números normales.
- subtotal: el total sin impuestos si figura, si no 0. tax_total: la suma de IVA y percepciones si figuran, si no 0. total: el total final a pagar.
- No inventes renglones ni números. Si algo no se lee con seguridad, ponelo igual con tu mejor lectura y explicalo en warnings (en castellano, corto, ej. "No se lee bien el precio del renglón 3").
- Si la imagen no es un comprobante de compra, devolvé items vacío y explicalo en warnings.`;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["supplier_name", "supplier_tax_id", "date", "invoice_number", "items", "subtotal", "tax_total", "total", "warnings"],
  properties: {
    supplier_name: { type: "string" },
    supplier_tax_id: { type: "string" },
    date: { type: "string" },
    invoice_number: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "quantity", "unit", "unit_price", "line_total"],
        properties: {
          description: { type: "string" },
          quantity: { type: "number" },
          unit: { type: "string", enum: ["kg", "unit"] },
          unit_price: { type: "number" },
          line_total: { type: "number" }
        }
      }
    },
    subtotal: { type: "number" },
    tax_total: { type: "number" },
    total: { type: "number" },
    warnings: { type: "array", items: { type: "string" } }
  }
};

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método no permitido" }, 405);

  try {
    if (!anthropic) return jsonResponse({ error: "La lectura de facturas todavía no está activada." }, 503);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Falta autenticación" }, 401);

    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: callerAuth, error: callerAuthErr } = await callerClient.auth.getUser();
    if (callerAuthErr || !callerAuth.user) return jsonResponse({ error: "Usuario no autenticado" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: profile } = await admin
      .from("profiles")
      .select("company_id,active,role,denied_permissions")
      .eq("id", callerAuth.user.id)
      .maybeSingle();
    if (!profile || !profile.active) return jsonResponse({ error: "Perfil inválido" }, 403);
    const denied: string[] = Array.isArray(profile.denied_permissions) ? profile.denied_permissions : [];
    if (!PURCHASE_ROLES.includes(profile.role) || denied.includes("purchases.manage")) {
      return jsonResponse({ error: "No tenés permiso para cargar compras." }, 403);
    }
    const { data: company } = await admin.from("companies").select("active").eq("id", profile.company_id).maybeSingle();
    if (!company?.active) return jsonResponse({ error: "Empresa inactiva" }, 403);

    const body = await req.json().catch(() => null) as { data?: unknown; media_type?: unknown } | null;
    const data = typeof body?.data === "string" ? body.data.replace(/\s/g, "") : "";
    const mediaType = typeof body?.media_type === "string" ? body.media_type : "";
    if (!data) return jsonResponse({ error: "No llegó la foto." }, 400);
    if (data.length > MAX_BASE64_CHARS) return jsonResponse({ error: "El archivo es muy grande. Probá con una foto o un PDF más chico." }, 413);
    const isPdf = mediaType === "application/pdf";
    const isImage = (IMAGE_TYPES as readonly string[]).includes(mediaType);
    if (!isPdf && !isImage) return jsonResponse({ error: "Mandá una foto (JPG o PNG) o un PDF." }, 400);

    const { data: allowed, error: usageErr } = await admin.rpc("bump_invoice_reader_usage", {
      p_company_id: profile.company_id,
      p_limit: DAILY_LIMIT_PER_COMPANY
    });
    if (usageErr) throw new Error(usageErr.message);
    if (!allowed) return jsonResponse({ error: `Llegaron al límite de ${DAILY_LIMIT_PER_COMPANY} facturas leídas hoy. Cargá el resto a mano o probá mañana.` }, 429);

    const fileBlock = isPdf
      ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data } }
      : { type: "image" as const, source: { type: "base64" as const, media_type: mediaType as (typeof IMAGE_TYPES)[number], data } };

    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      system: INSTRUCTIONS,
      messages: [{ role: "user", content: [fileBlock, { type: "text", text: "Extraé los datos de este comprobante." }] }]
    } as never) as unknown as { stop_reason: string; content: { type: string; text?: string }[] };

    if (response.stop_reason === "refusal") return jsonResponse({ error: "No se pudo leer este archivo. Cargá la compra a mano." }, 422);
    if (response.stop_reason === "max_tokens") return jsonResponse({ error: "La factura es muy larga para leerla de una vez. Cargá la compra a mano." }, 422);
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    let invoice: unknown;
    try {
      invoice = JSON.parse(text);
    } catch {
      throw new Error("La respuesta no es JSON");
    }
    return jsonResponse({ invoice });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return jsonResponse({ error: "Hay muchas lecturas al mismo tiempo. Probá de nuevo en un minuto." }, 503);
    }
    if (err instanceof Anthropic.BadRequestError) {
      console.error("invoice-reader bad request:", err.message);
      return jsonResponse({ error: "No se pudo leer ese archivo. Probá con otra foto, más derecha y con buena luz." }, 422);
    }
    console.error("invoice-reader error:", err);
    return jsonResponse({ error: "No pude leer la factura en este momento. Probá de nuevo en un rato." }, 500);
  }
});
