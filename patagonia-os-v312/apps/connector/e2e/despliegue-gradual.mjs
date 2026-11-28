// Despliegue gradual y freno de Scale Connect contra la lógica REAL de la base: corre la migración 229 ENTERA
// (supabase/migrations/229_scale_connect_releases.sql, sin cambiar una línea) en PGlite (Postgres en WASM) sobre un
// esquema mínimo con lo que la 229 toca de antes (companies, scale_connectors, audit_log, auth, storage, roles), y
// pregunta la oferta como lo hace la Edge Function: scale_connector_update_offer(id, hash, versión).
//
// Comprueba:
//   - 0 % no le ofrece a nadie; 100 % a todos; 10 % → 50 % mantiene a los primeros (balde estable por conector);
//   - el balde es el documentado: primeros 4 bytes del SHA-256 del id, módulo 100 (se recalcula en JS y coincide);
//   - "frenar" (set_scale_connect_release(id, false)) deja de ofrecerla; reactivar vuelve;
//   - no ofrece la misma versión ni una más vieja; el canal piloto solo a las empresas piloto.
// El manifiesto se firma con una clave Ed25519 generada en memoria en esta corrida (no se guarda en ningún lado).
//
// Uso: node e2e/despliegue-gradual.mjs --pglite <carpeta con node_modules/@electric-sql/pglite> [--out resultado.json]

import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSignedManifest } from "../scripts/lib/update-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const pgliteDir = opt("pglite");
if (!pgliteDir) throw new Error("Falta --pglite <carpeta>");
const { PGlite } = createRequire(path.join(path.resolve(pgliteDir), "package.json"))("@electric-sql/pglite");

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "OK   " : "FALLA"} ${name}${detail ? `  (${detail})` : ""}`);
}

// Lo mínimo que la 229 necesita que exista (en Supabase ya está). Nada de esto es lógica de la oferta.
const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table public.companies (id uuid primary key, name text);
create table public.scale_connectors (
  id uuid primary key, company_id uuid not null references public.companies(id), branch_id uuid,
  version text, status text not null default 'active', secret_hash text not null
);
create table public.audit_log (
  id bigserial primary key, company_id uuid, branch_id uuid, user_id uuid, action text, entity_type text,
  entity_id text, old_data jsonb, new_data jsonb, created_at timestamptz default now()
);
create table public.schema_migrations (version text primary key);
create function public.accountant_readonly_guard() returns trigger language plpgsql as $$ begin return null; end $$;
create function public.am_i_platform_admin() returns boolean language sql stable as $$ select true $$;
-- Igual que la 226: id + hash del secreto, si no, PT401.
create function public.scale_connector_auth(p_connector_id uuid, p_secret_hash text) returns public.scale_connectors
language plpgsql stable as $$
declare v public.scale_connectors%rowtype;
begin
  select * into v from public.scale_connectors where id = p_connector_id and secret_hash = p_secret_hash and status = 'active';
  if v.id is null then raise exception 'Credencial inválida' using errcode = 'PT401'; end if;
  return v;
end $$;
`;

const db = new PGlite();
await db.exec(STUB);
const migration = await readFile(path.join(repo, "supabase", "migrations", "229_scale_connect_releases.sql"), "utf8");
await db.exec(migration);
check("La migración 229 corre entera en PGlite", true, `${migration.length} caracteres`);

// Una empresa estable y una piloto, 200 PC en total.
const stable = randomUUID();
const pilot = randomUUID();
await db.query("insert into public.companies (id, name) values ($1, 'Estable'), ($2, 'Piloto')", [stable, pilot]);
await db.query("update public.companies set scale_connect_channel = 'pilot' where id = $1", [pilot]);
const pcs = [];
for (let i = 0; i < 200; i++) {
  const id = randomUUID();
  const hash = createHash("sha256").update(`secreto-${i}`).digest("hex");
  const company = i < 180 ? stable : pilot;
  await db.query("insert into public.scale_connectors (id, company_id, version, secret_hash) values ($1, $2, '9.0.0', $3)", [id, company, hash]);
  pcs.push({ id, hash, company });
}

const { privateKey } = generateKeyPairSync("ed25519");
const manifest = (version, channel) =>
  createSignedManifest(
    { version, channel, minVersion: "9.0.0", url: `https://example.invalid/${version}.exe`, sha256: "a".repeat(64), size: 1234 },
    privateKey,
  );

// Como la sesión de un administrador de plataforma (auth.uid() = alguien de auth.users).
const admin = randomUUID();
await db.query("insert into auth.users (id) values ($1)", [admin]);
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [admin]);

async function offered(list, current = "9.0.0") {
  const out = new Set();
  for (const pc of list) {
    const r = await db.query("select public.scale_connector_update_offer($1, $2, $3) as o", [pc.id, pc.hash, current]);
    const o = r.rows[0].o;
    if (o.offer) out.add(`${pc.id}=${o.offer.version}`);
  }
  return out;
}
const ids = (set) => new Set([...set].map((s) => s.split("=")[0]));
const stablePcs = pcs.filter((p) => p.company === stable);
const pilotPcs = pcs.filter((p) => p.company === pilot);

// Balde: el de la base contra el documentado, calculado en JS.
const jsBucket = (id) => createHash("sha256").update(id, "utf8").digest().readUInt32BE(0) % 100;
let same = 0;
for (const pc of pcs) {
  const r = await db.query("select public.scale_connect_rollout_bucket($1) as b", [pc.id]);
  if (r.rows[0].b === jsBucket(pc.id)) same++;
}
check("Balde = primeros 4 bytes del SHA-256 del id, módulo 100", same === pcs.length, `${same}/${pcs.length} iguales al cálculo en JS`);
const again = await db.query("select public.scale_connect_rollout_bucket($1) as b", [pcs[0].id]);
check("El balde de un conector no cambia entre consultas", again.rows[0].b === jsBucket(pcs[0].id), `balde ${again.rows[0].b}`);

// Publicar 9.0.1 estable al 0 %.
const pub = await db.query("select public.publish_scale_connect_release($1::jsonb, 'stable', 0) as id", [JSON.stringify(manifest("9.0.1", "general"))]);
const releaseId = pub.rows[0].id;
const at0 = await offered(pcs);
check("Al 0 % no se le ofrece a nadie", at0.size === 0, `${at0.size} de ${pcs.length}`);

await db.query("select public.set_scale_connect_release($1, true, 10)", [releaseId]);
const at10 = ids(await offered(pcs));
const expected10 = pcs.filter((p) => jsBucket(p.id) < 10).length;
check("Al 10 %: solo los de balde < 10", at10.size === expected10 && [...at10].every((id) => jsBucket(id) < 10), `${at10.size} PC (esperadas ${expected10})`);

await db.query("select public.set_scale_connect_release($1, true, 50)", [releaseId]);
const at50 = ids(await offered(pcs));
check("Al 50 %: los del 10 % siguen adentro (estable)", [...at10].every((id) => at50.has(id)) && at50.size > at10.size, `${at50.size} PC`);
const at50b = ids(await offered(pcs));
check("Misma consulta, mismas PC (sin azar)", at50b.size === at50.size && [...at50].every((id) => at50b.has(id)), "");

await db.query("select public.set_scale_connect_release($1, true, 100)", [releaseId]);
const at100 = ids(await offered(pcs));
check("Al 100 % se le ofrece a todos", at100.size === pcs.length, `${at100.size} de ${pcs.length}`);

const same901 = await offered(pcs, "9.0.1");
const newer = await offered(pcs, "9.0.2");
check("No ofrece la misma versión ni una más vieja", same901.size === 0 && newer.size === 0, `con 9.0.1: ${same901.size}, con 9.0.2: ${newer.size}`);

// Frenar.
await db.query("select public.set_scale_connect_release($1, false)", [releaseId]);
const stopped = await offered(pcs);
check("Frenada (set_scale_connect_release(id, false)): deja de ofrecerse", stopped.size === 0, `${stopped.size} PC`);
const cfgShape = await db.query("select public.scale_connector_update_offer($1, $2, null) as o", [pcs[0].id, pcs[0].hash]);
check("Frenada: /config tampoco la anuncia (oferta null)", cfgShape.rows[0].o.offer === null, JSON.stringify(cfgShape.rows[0].o));
await db.query("select public.set_scale_connect_release($1, true)", [releaseId]);
const resumed = await offered(pcs);
check("Reactivada: vuelve a ofrecerse con el mismo porcentaje", resumed.size === pcs.length, `${resumed.size} PC`);

// Piloto: 9.0.2 en piloto al 100 % solo para la empresa piloto.
await db.query("select public.publish_scale_connect_release($1::jsonb, 'pilot', 100)", [JSON.stringify(manifest("9.0.2", "piloto"))]);
const st = await offered(stablePcs);
const pi = await offered(pilotPcs);
check(
  "Piloto: la 9.0.2 solo le llega a la empresa piloto; la estable sigue con la 9.0.1",
  [...st].every((s) => s.endsWith("=9.0.1")) && [...pi].every((s) => s.endsWith("=9.0.2")) && pi.size === pilotPcs.length,
  `estable: ${st.size}× 9.0.1, piloto: ${pi.size}× 9.0.2`,
);
const shape = (await db.query("select public.scale_connector_update_offer($1, $2, '9.0.0') as o", [pilotPcs[0].id, pilotPcs[0].hash])).rows[0].o;
check(
  "La oferta tiene la forma que espera el conector (channel + offer.version + offer.manifest firmado)",
  shape.channel === "pilot" && shape.offer?.version === "9.0.2" && shape.offer?.manifest?.signature?.length === 88,
  `channel ${shape.channel}, offer ${shape.offer?.version}`,
);
let denied = false;
try {
  await db.query("select public.scale_connector_update_offer($1, 'otro', '9.0.0')", [pcs[0].id]);
} catch (error) {
  denied = String(error.code ?? error.message).includes("PT401") || /Credencial/.test(String(error.message));
}
check("Con otro secreto: PT401 (no se ofrece nada sin la credencial)", denied, "");

const out = opt("out");
if (out) await writeFile(out, `${JSON.stringify({ checks }, null, 2)}\n`);
await db.close();
const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.error(`${failed.length} comprobaciones fallaron`);
  process.exit(1);
}
