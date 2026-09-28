// Deploy a Netlify por API, sin el CLI. Sirve cuando el CLI falla con
// "Unauthorized: could not retrieve project" (pasa si el token solo tiene
// permisos sobre el sitio y no sobre el usuario) o se cuelga.
//
// Dos pasos, para no arriesgar a todos los clientes con un deploy roto:
//   node scripts/deploy-netlify.mjs draft            -> sube apps/web/dist como BORRADOR y muestra su URL
//   node scripts/deploy-netlify.mjs publish <deployId> -> publica ese borrador en producción
//
// Token en la variable NETLIFY_AUTH_TOKEN (nunca en el chat ni en un archivo).
// Las redirecciones viven en netlify.toml, que la API no lee: se sube el
// equivalente como archivo _redirects dentro del deploy.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SITE_ID = process.env.NETLIFY_SITE_ID ?? "2cbcab78-0bfb-42c5-bbcf-87791a7d2c89";
const TOKEN = process.env.NETLIFY_AUTH_TOKEN;
const DIST = process.env.DEPLOY_DIR ?? "apps/web/dist";
const API = "https://api.netlify.com/api/v1";

if (!TOKEN) throw new Error("Falta la variable NETLIFY_AUTH_TOKEN");

const REDIRECTS = "/api/*  /.netlify/functions/:splat  200\n/*  /index.html  200\n";

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

async function publish(id) {
  if (!id) throw new Error("Falta el id del borrador: node scripts/deploy-netlify.mjs publish <deployId>");
  const d = await api("POST", `/sites/${SITE_ID}/deploys/${id}/restore`, "{}", { "Content-Type": "application/json" });
  console.log(JSON.stringify({ id: d.id, state: d.state, published: d.published_at ?? null, url: d.ssl_url ?? d.url }));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "draft") await draft();
else if (cmd === "publish") await publish(arg);
else console.log("Uso: node scripts/deploy-netlify.mjs draft | publish <deployId>");
