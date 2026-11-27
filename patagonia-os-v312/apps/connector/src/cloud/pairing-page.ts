// Página local de vinculación: http://127.0.0.1:9120/vincular
//
// Un formulario simple para el código de 8 caracteres y el nombre de la PC. Si la nube reconoce la huella
// (reinstalación), pregunta "¿Es Caja 1?" y la recupera.
//
// Seguridad (además de las reglas de Host y Origin del canal local):
// - El POST solo se acepta si el Origin es ESTA misma página (http://127.0.0.1:<puerto> o localhost), no la web
//   de Patagonia ni otro puerto local: una página de afuera no puede vincular esta PC a otra empresa.
// - Token anti-CSRF al azar por proceso, metido en el formulario (otra página no lo puede leer: sin CORS).
// - Si la PC ya está vinculada no hay formulario: para cambiarla hay que desvincularla desde Patagonia.
// - Sin iframes (X-Frame-Options / CSP frame-ancestors) y sin scripts.

import { randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import type http from "node:http";
import type { LocalRoute } from "../server/local-server";
import type { AgentPairResult, CloudAgent } from "./cloud-agent";

export const PAIRING_PATH = "/vincular";
const MAX_FORM_BYTES = 4096;

export interface PairingPageOptions {
  agent: CloudAgent;
  /** Para pruebas: token fijo. */
  csrfToken?: string;
}

const ERRORS: Record<string, string> = {
  codigo_invalido: "El código no es válido, ya se usó o venció (dura 10 minutos). Pedí uno nuevo en Patagonia → Mis balanzas → Agregar esta computadora.",
  falta_codigo: "Escribí el código que aparece en Patagonia.",
  nombre_invalido: "Poné un nombre para esta computadora (hasta 40 letras), por ejemplo \"Caja 1\".",
  nombre_repetido: "Ya hay otra computadora con ese nombre. Elegí otro.",
  demasiados_intentos: "Hubo demasiados intentos. Esperá 10 minutos y probá de nuevo.",
  demasiados_conectores: "Esta empresa ya tiene el máximo de computadoras vinculadas. Desvinculá alguna desde Patagonia.",
  no_se_puede_recuperar: "No se pudo recuperar esa computadora. Elegí \"No, es otra computadora\".",
  huella_invalida: "No se pudo identificar esta computadora. Escribile a soporte.",
  sin_conexion: "No hay conexión con Patagonia. Revisá que esta computadora tenga internet y probá de nuevo.",
  error_servidor: "Patagonia no respondió bien. Probá de nuevo en un minuto.",
  no_configurado: "Falta configurar la dirección de Patagonia en Scale Connect. Escribile a soporte.",
  ya_vinculada: "Esta computadora ya está vinculada.",
  ocupado: "Ya se está vinculando. Esperá unos segundos.",
  pedido_invalido: "El formulario venció. Volvé a abrir esta página.",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function errorText(code: string): string {
  return ERRORS[code] ?? `No se pudo vincular (${code}).`;
}

/** El Origin del POST tiene que ser esta misma página. */
export function isSelfOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

const STYLE = `body{font-family:Segoe UI,Arial,sans-serif;background:#f4f5f7;color:#1d2433;margin:0}
main{max-width:520px;margin:48px auto;background:#fff;border-radius:12px;padding:28px 32px;box-shadow:0 2px 12px #0001}
h1{font-size:22px;margin:0 0 6px}p{line-height:1.45}.muted{color:#5b6475}
label{display:block;margin:16px 0 6px;font-weight:600}input[type=text]{width:100%;box-sizing:border-box;font-size:20px;padding:10px 12px;border:1px solid #c9cfda;border-radius:8px}
input.code{letter-spacing:4px;text-transform:uppercase;font-family:Consolas,monospace}
button{margin-top:20px;font-size:17px;padding:11px 20px;border:0;border-radius:8px;background:#1f6feb;color:#fff;cursor:pointer}
button.secondary{background:#e8ebf0;color:#1d2433}.error{background:#fdecec;color:#8a1c1c;padding:12px 14px;border-radius:8px}
.ok{background:#e7f6ec;color:#185c2f;padding:12px 14px;border-radius:8px}form.inline{display:inline-block;margin-right:8px}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Patagonia Scale Connect</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html);
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

export function renderForm(input: { csrf: string; code?: string; name?: string; error?: string | null; notice?: string | null }): string {
  return page(
    "Vincular",
    `<h1>Vincular esta computadora</h1>
<p class="muted">En Patagonia entrá a <b>Mis balanzas → Computadoras con Scale Connect → Agregar esta computadora</b> y escribí acá el código que aparece.</p>
${input.notice ? `<p class="error">${escapeHtml(input.notice)}</p>` : ""}
${input.error ? `<p class="error">${escapeHtml(errorText(input.error))}</p>` : ""}
<form method="post" action="${PAIRING_PATH}">
${hidden("csrf", input.csrf)}
<label for="code">Código</label>
<input id="code" class="code" type="text" name="code" maxlength="12" autocomplete="off" required value="${escapeHtml(input.code ?? "")}" placeholder="ABCD-EFGH">
<label for="name">Nombre de esta computadora</label>
<input id="name" type="text" name="name" maxlength="40" required value="${escapeHtml(input.name ?? "")}" placeholder="Caja 1">
<button type="submit">Vincular</button>
</form>`,
  );
}

export function renderChoice(input: { csrf: string; code: string; name: string; candidates: Array<{ id: string; name: string; lastSeenAt: string | null }> }): string {
  const options = input.candidates
    .map(
      (c) => `<form class="inline" method="post" action="${PAIRING_PATH}">${hidden("csrf", input.csrf)}${hidden("code", input.code)}${hidden("recover_id", c.id)}
<button type="submit">Sí, es ${escapeHtml(c.name)}</button></form>`,
    )
    .join("");
  const first = input.candidates[0]?.name ?? "la de antes";
  return page(
    "¿Es la misma computadora?",
    `<h1>¿Es ${escapeHtml(first)}?</h1>
<p>Esta computadora ya estuvo vinculada a tu negocio. Si es la misma (por ejemplo, reinstalaste Scale Connect), recuperala y sigue con sus balanzas.</p>
${options}
<form class="inline" method="post" action="${PAIRING_PATH}">${hidden("csrf", input.csrf)}${hidden("code", input.code)}${hidden("force_new", "1")}
<input type="text" name="name" maxlength="40" required value="${escapeHtml(input.name)}" aria-label="Nombre nuevo" style="margin-top:20px">
<button class="secondary" type="submit">No, es otra computadora</button></form>`,
  );
}

export function renderPaired(input: { name: string; recovered?: boolean }): string {
  return page(
    "Vinculada",
    `<h1>${input.recovered ? "Computadora recuperada" : "¡Listo!"}</h1>
<p class="ok">Esta computadora quedó vinculada como <b>${escapeHtml(input.name)}</b>.</p>
<p class="muted">Ya podés cerrar esta ventana. En Patagonia → Mis balanzas la vas a ver "En línea" en menos de un minuto.</p>`,
  );
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams | null> {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createPairingRoute(options: PairingPageOptions): LocalRoute {
  const csrf = options.csrfToken ?? randomBytes(24).toString("base64url");
  const agent = options.agent;

  return async ({ req, res, url, origin, port }) => {
    if (url.pathname !== PAIRING_PATH) return false;

    if (req.method === "GET" || req.method === "HEAD") {
      const status = agent.status();
      if (agent.isPaired) {
        sendHtml(res, 200, renderPaired({ name: String(status.name ?? "") }));
      } else if (!agent.configured) {
        sendHtml(res, 200, page("Vincular", `<h1>Vincular esta computadora</h1><p class="error">${escapeHtml(errorText("no_configurado"))}</p>`));
      } else {
        const notice = status.state === "desvinculada" ? "Esta computadora fue desvinculada desde Patagonia. Para volver a usarla, pedí un código nuevo." : null;
        sendHtml(res, 200, renderForm({ csrf, name: os.hostname().slice(0, 40), notice }));
      }
      return true;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "GET, POST", "Content-Type": "text/plain; charset=utf-8" });
      res.end("Método no permitido");
      return true;
    }
    // Solo desde esta misma página.
    if (!isSelfOrigin(origin, port)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Origen no permitido");
      return true;
    }
    const form = await readForm(req);
    if (!form || !sameToken(form.get("csrf") ?? "", csrf)) {
      sendHtml(res, 403, renderForm({ csrf, error: "pedido_invalido" }));
      return true;
    }
    if (agent.isPaired) {
      sendHtml(res, 409, renderPaired({ name: String(agent.status().name ?? "") }));
      return true;
    }

    const code = (form.get("code") ?? "").slice(0, 20);
    const name = (form.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const recoverId = form.get("recover_id");
    const forceNew = form.get("force_new") === "1";
    const result: AgentPairResult = await agent.pair({ code, name, recoverId: recoverId || null, forceNew });

    if (result.kind === "paired") sendHtml(res, 200, renderPaired({ name: result.name, recovered: result.recovered }));
    else if (result.kind === "choose") sendHtml(res, 200, renderChoice({ csrf, code, name, candidates: result.candidates }));
    else sendHtml(res, 400, renderForm({ csrf, code, name, error: result.error }));
    return true;
  };
}
