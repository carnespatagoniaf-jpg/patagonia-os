// Deploy a Netlify por API, sin el CLI. Sirve cuando el CLI falla con
// "Unauthorized: could not retrieve project" (pasa si el token solo tiene
// permisos sobre el sitio y no sobre el usuario) o se cuelga.
//
// Dos pasos, para no arriesgar a todos los clientes con un deploy roto:
//   node scripts/deploy-netlify.mjs draft            -> sube apps/web/dist como BORRADOR y muestra su URL
//   node scripts/deploy-netlify.mjs publish <deployId> -> publica ese borrador en producción
//   node scripts/deploy-netlify.mjs current            -> id de la versión publicada ahora
//   node scripts/deploy-netlify.mjs rollback [deployId] -> vuelve a esa versión (sin id: a la publicada antes de la actual)
//
// Token en la variable NETLIFY_AUTH_TOKEN (nunca en el chat ni en un archivo).
// Las redirecciones y los encabezados viven en netlify.toml, que la API no lee: se
// suben los equivalentes como archivos _redirects y _headers dentro del deploy.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SITE_ID = process.env.NETLIFY_SITE_ID ?? "2cbcab78-0bfb-42c5-bbcf-87791a7d2c89";
const TOKEN = process.env.NETLIFY_AUTH_TOKEN;
const DIST = process.env.DEPLOY_DIR ?? "apps/web/dist";
const API = "https://api.netlify.com/api/v1";

if (!TOKEN) throw new Error("Falta la variable NETLIFY_AUTH_TOKEN");

const REDIRECTS = "/api/*  /.netlify/functions/:splat  200\n/*  /index.html  200\n";
// Igual que [[headers]] de netlify.toml: los archivos con huella se guardan un año en el navegador.
const HEADERS = "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n";

async function api(method, url, body, headers = {}) {
  const res = await fetch(API + url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
    body
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push({ rel: "/" + path.relative(base, full).split(path.sep).join("/"), full });
  }
  return out;
}

const sha1 = (buf) => createHash("sha1").update(buf).digest("hex");

async function draft() {
  const files = walk(DIST).map((f) => ({ ...f, data: fs.readFileSync(f.full) }));
  files.push({ rel: "/_redirects", data: Buffer.from(REDIRECTS) });
  files.push({ rel: "/_headers", data: Buffer.from(HEADERS) });
  const digest = Object.fromEntries(files.map((f) => [f.rel, sha1(f.data)]));

  const deploy = await api("POST", `/sites/${SITE_ID}/deploys`, JSON.stringify({ files: digest, draft: true }), { "Content-Type": "application/json" });
  const required = new Set(deploy.required ?? []);
  let uploaded = 0;
  for (const f of files) {
    if (!required.has(digest[f.rel])) continue;
    await api("PUT", `/deploys/${deploy.id}/files${encodeURI(f.rel)}`, f.data, { "Content-Type": "application/octet-stream" });
    uploaded += 1;
  }
  for (let i = 0; i < 60; i++) {
    const d = await api("GET", `/deploys/${deploy.id}`);
    if (d.state === "ready") {
      console.log(JSON.stringify({ id: d.id, state: d.state, files: files.length, uploaded, url: d.deploy_ssl_url ?? d.deploy_url }));
      return;
    }
    if (d.state === "error") throw new Error("El deploy quedó en error: " + (d.error_message ?? ""));
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("El borrador no llegó a 'ready' a tiempo");
}

/**
 * Traba antes de publicar (auditoría 29/10/2026, crítico C5): la web del 29/10 salió pidiendo la columna de la
 * migración 172, que no estaba en producción, y Mostrador se cayó para todos casi 2 horas. Se compara cada
 * migración del repo (099 en adelante, las que registra schema_migrations) con la base de producción, por la
 * API de Supabase (variable SUPABASE_ACCESS_TOKEN, solo lectura). Si falta alguna, NO se publica.
 * Saltear solo a conciencia: SALTEAR_CONTROL_MIGRACIONES=1.
 */
async function assertMigrationsApplied() {
  if (process.env.SALTEAR_CONTROL_MIGRACIONES === "1") {
    console.warn("ATENCIÓN: se salteó el control de migraciones (SALTEAR_CONTROL_MIGRACIONES=1).");
    return;
  }
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!accessToken) throw new Error("Falta SUPABASE_ACCESS_TOKEN para comprobar que producción tiene todas las migraciones. No se publicó.");
  const ref = process.env.SUPABASE_PROJECT_REF ?? "tayylvhfmoybchutybcz";
  const local = fs
    .readdirSync("supabase/migrations")
    .filter((f) => /^\d{3}_.+\.sql$/.test(f) && !f.endsWith(".rollback.sql") && Number(f.slice(0, 3)) >= 99)
    .map((f) => f.replace(/\.sql$/, ""));
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "select version from public.schema_migrations" })
  });
  if (!res.ok) throw new Error(`No se pudo leer schema_migrations de producción (${res.status}). No se publicó.`);
  const applied = new Set((await res.json()).map((r) => r.version));
  const missing = local.filter((v) => !applied.has(v));
  if (missing.length > 0) {
    throw new Error(`Producción no tiene estas migraciones: ${missing.join(", ")}. Aplicalas primero; la web nueva puede depender de ellas. No se publicó.`);
  }
  console.log(`Control de migraciones: producción tiene las ${local.length} del repo (099 en adelante).`);
}

async function publish(id, { checkMigrations = true } = {}) {
  if (!id) throw new Error("Falta el id del borrador: node scripts/deploy-netlify.mjs publish <deployId>");
  if (checkMigrations) await assertMigrationsApplied();
  const d = await api("POST", `/sites/${SITE_ID}/deploys/${id}/restore`, "{}", { "Content-Type": "application/json" });
  console.log(JSON.stringify({ id: d.id, state: d.state, published: d.published_at ?? null, url: d.ssl_url ?? d.url }));
}

async function current() {
  const site = await api("GET", `/sites/${SITE_ID}`);
  console.log(JSON.stringify({ id: site.published_deploy?.id ?? null, url: site.ssl_url ?? site.url }));
}

/** Volver atrás: a la versión indicada o, sin id, a la última publicada antes de la actual. */
async function rollback(id) {
  let target = id;
  if (!target) {
    const site = await api("GET", `/sites/${SITE_ID}`);
    const now = site.published_deploy?.id;
    const deploys = await api("GET", `/sites/${SITE_ID}/deploys?per_page=50`);
    const previous = deploys
      .filter((d) => d.id !== now && d.state === "ready" && d.published_at)
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
    if (!previous) throw new Error("No encontré una versión anterior publicada");
    target = previous.id;
  }
  // Volver a una versión anterior nunca necesita migraciones nuevas: sin control, para que sea inmediato.
  await publish(target, { checkMigrations: false });
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "draft") await draft();
else if (cmd === "publish") await publish(arg);
else if (cmd === "current") await current();
else if (cmd === "rollback") await rollback(arg);
else console.log("Uso: node scripts/deploy-netlify.mjs draft | publish <deployId> | current | rollback [deployId]");
