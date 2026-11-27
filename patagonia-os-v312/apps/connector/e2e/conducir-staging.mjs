// Conductor de la prueba de punta a punta (.github/workflows/scale-connect-e2e.yml): lo que hace la WEB, contra el
// sistema de PRUEBAS (staging), mientras el workflow corre en la PC limpia. Corre en la PC de quien prueba.
//
//   node apps/connector/e2e/conducir-staging.mjs --empresa "<nombre de la empresa de pruebas>" [--sucursal "<nombre>"]
//
// Necesita: la variable SUPABASE_STAGING_ACCESS_TOKEN (Management API de staging; NUNCA la de producción), `gh` con
// acceso al repo y `git` en esta rama. No guarda ningún identificador: busca la empresa, la sucursal y la persona por
// nombre. Actúa como el dueño o un administrador de esa empresa con las MISMAS RPC que la web (create_scale_connector_pairing,
// register_branch_scale, bind_scale_to_connector, queue_scale_job), poniendo su id en request.jwt.claims solo para
// esa consulta.
//
// Sigue el paso en curso de la corrida (gh api …/jobs):
//   "Vincular con staging" → crea el código (10 minutos, un solo uso) y lo sube a e2e/codigo.txt con "[skip ci]".
//   "Fase 1"               → identificar las balanzas de la PC, registrarlas, vincularlas al puerto y dos envíos a la vez.
//   "Fase 2"               → dos envíos (la Report se corta a mitad).
//   "Fase 3"               → con la red de la PC cortada, dos envíos (quedan en la nube hasta que vuelve).
//   "Fase 4"               → una prueba de conexión después de reinstalar.
// Al terminar baja los artefactos y compara, producto por producto, scale_jobs / scale_job_items con lo que quedó
// grabado en cada balanza simulada. Escribe e2e-resultado/<run>/resultado.json y sale con 1 si algo no dio.

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STAGING_REF = "loquhcwsvsbqpinefxcc";
const BRANCH = "prueba/scale-connect-e2e";
const WORKFLOW = "scale-connect-e2e.yml";
const IDENTIFY_SCALE_KEY = "__buscar-balanzas__";
const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "../../..");

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const companyName = arg("empresa");
const branchName = arg("sucursal");
const runArg = arg("run");
if (!companyName) throw new Error("Falta --empresa");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const jsonLit = (v) => `${lit(JSON.stringify(v))}::jsonb`;

const token =
  process.env.SUPABASE_STAGING_ACCESS_TOKEN ||
  execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('SUPABASE_STAGING_ACCESS_TOKEN','User')"`).toString().trim();
if (!token) throw new Error("Falta SUPABASE_STAGING_ACCESS_TOKEN");

async function sql(query) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${STAGING_REF}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const text = await r.text();
    if (r.ok) return JSON.parse(text);
    if ((r.status === 429 || r.status >= 500) && attempt < 5) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new Error(`SQL ${r.status}: ${text.slice(0, 500)}`);
  }
}

/** Como la persona (auth.uid()), solo en esta consulta. */
const asUser = (userId, query) => sql(`select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: userId, role: "authenticated" }))}, true);\n${query}`);

const gh = (args) => execFileSync("gh", args, { cwd: projectDir, encoding: "utf8" });
const git = (args) => execFileSync("git", args, { cwd: projectDir, encoding: "utf8" });

// ── quién ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const [company] = await sql(`select id, name from companies where name ilike ${lit(`%${companyName}%`)} and active order by name limit 1`);
if (!company) throw new Error(`No está la empresa "${companyName}" en staging`);
const [branch] = await sql(
  `select id, name from branches where company_id = ${lit(company.id)} and active and not coalesce(is_vehicle, false) ${branchName ? `and name ilike ${lit(`%${branchName}%`)}` : ""} order by created_at limit 1`,
);
const [admin] = await sql(`select id, full_name, role from profiles where company_id = ${lit(company.id)} and active and role in ('owner', 'admin') order by role desc, created_at limit 1`);
if (!branch || !admin) throw new Error("Falta la sucursal o un dueño/administrador");
log(`Empresa "${company.name}", sucursal "${branch.name}", como "${admin.full_name}" (${admin.role})`);

// ── la corrida ────────────────────────────────────────────────────────────────────────────────────────────────────
async function findRun() {
  if (runArg) return Number(runArg);
  const head = git(["rev-parse", "HEAD"]).trim();
  for (;;) {
    const runs = JSON.parse(gh(["run", "list", "--workflow", WORKFLOW, "--branch", BRANCH, "--limit", "10", "--json", "databaseId,headSha,status"]));
    const run = runs.find((r) => r.headSha === head && r.status !== "completed");
    if (run) return run.databaseId;
    log("Esperando una corrida para", head.slice(0, 8));
    await sleep(10_000);
  }
}
const runId = await findRun();
const outDir = path.join(arg("salida", path.join(os.tmpdir(), "scale-connect-e2e")), String(runId));
mkdirSync(outDir, { recursive: true });
log(`Corrida ${runId}: https://github.com/${gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim()}/actions/runs/${runId}`);
const result = { run: runId, company: company.name, branch: branch.name, phases: {}, checks: [], created: { pairings: [], connectors: [], scales: [], jobs: [] } };
const save = () => writeFileSync(path.join(outDir, "resultado.json"), JSON.stringify(result, null, 2));
const check = (area, name, ok, detail = "") => {
  result.checks.push({ area, name, ok: !!ok, detail });
  log(ok ? "OK   " : "FALLA", `[${area}] ${name}`, detail);
  save();
};

async function steps() {
  const jobs = JSON.parse(gh(["api", `repos/{owner}/{repo}/actions/runs/${runId}/jobs`]));
  const job = jobs.jobs[0];
  return { job, steps: job?.steps ?? [] };
}

// ── acciones ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function pairingCode() {
  const [r] = await asUser(admin.id, `select public.create_scale_connector_pairing(${lit(branch.id)}) as p`);
  const code = r.p.code;
  const [row] = await sql(`select id from scale_connector_pairings where company_id = ${lit(company.id)} order by created_at desc limit 1`);
  result.created.pairings.push(row.id);
  const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
  const file = path.join(projectDir, "apps/connector/e2e/codigo.txt");
  writeFileSync(
    file,
    `# Código de vinculación de UNA corrida de scale-connect-e2e.yml (vence a los 10 minutos y se usa una sola vez).\nrun=${runId} codigo=${pretty}\n`,
  );
  git(["add", "apps/connector/e2e/codigo.txt"]);
  git(["commit", "-m", `Prueba Scale Connect: código de vinculación de la corrida ${runId} [skip ci]\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`]);
  git(["push", "origin", `HEAD:${BRANCH}`]);
  log(`Código ${pretty} creado (vence ${r.p.expires_at}) y subido`);
  save();
}

async function connector() {
  for (let i = 0; i < 120; i++) {
    const [c] = await sql(
      `select id, name, version, last_seen_at, seen_scales from scale_connectors where company_id = ${lit(company.id)} and status = 'active' and name = ${lit(`PC limpia e2e ${runId}`)}`,
    );
    if (c && (c.seen_scales ?? []).filter((s) => s.device).length >= 2) return c;
    await sleep(5000);
  }
  throw new Error("El conector no apareció con sus dos balanzas");
}

async function queue(scaleKey, kind, payload, connectorId) {
  const [r] = await asUser(admin.id, `select public.queue_scale_job(${lit(scaleKey)}, ${lit(kind)}, ${jsonLit(payload)}, ${lit(branch.id)}, ${lit(connectorId)}) as id`);
  result.created.jobs.push(r.id);
  save();
  return r.id;
}

async function waitJobs(ids, minutes = 20) {
  const end = Date.now() + minutes * 60_000;
  for (;;) {
    const rows = await sql(`select id, scale_key, kind, status, error_code, started_at, claimed_at, finished_at, progress, requested_count, confirmed_count, failed_count, skipped_count from scale_jobs where id in (${ids.map(lit).join(",")})`);
    if (rows.length === ids.length && rows.every((r) => !["queued", "running"].includes(r.status))) return ids.map((id) => rows.find((r) => r.id === id));
    if (Date.now() > end) throw new Error(`Los trabajos no terminaron: ${JSON.stringify(rows.map((r) => [r.scale_key, r.status]))}`);
    await sleep(3000);
  }
}

const items = (jobId) => sql(`select plu, product_id, action, status, reason, sent, read_back from scale_job_items where job_id = ${lit(jobId)} order by plu`);

let products = [];
let payload = null;
const scaleKeys = {};
let conn = null;

async function phase1() {
  conn = await connector();
  result.created.connectors.push(conn.id);
  log(`Conector ${conn.id} (${conn.version}) ve: ${conn.seen_scales.map((s) => s.key).join(", ")}`);
  // Agregar balanza → En esta computadora: identificar (solo lectura)
  const idJob = await queue(IDENTIFY_SCALE_KEY, "read", { mode: "identify" }, conn.id);
  const [idRow] = await waitJobs([idJob], 10);
  const found = await items(idJob);
  result.phases.identify = { job: idRow, items: found };
  check("Envío doble", "Identificar por la nube: encuentra la Report y la Cuora", idRow.status === "done" && ["kretz", "systel"].every((f) => found.some((i) => i.read_back?.family === f)), found.map((i) => `${i.read_back?.family} ${i.read_back?.label} ${i.sent?.host}:${i.sent?.port}`).join("; "));
  // Registrar y vincular cada una a su puerto (lo que hace Mis balanzas)
  for (const f of found) {
    const family = f.read_back.family;
    const key = `${family}-e2e-${runId}`;
    await asUser(admin.id, `select public.register_branch_scale(${lit(branch.id)}, ${lit(key)}, ${lit(`E2E ${f.read_back.label}`)}, ${lit(family)}, null, ${lit(f.read_back.model)}, ${jsonLit(f.read_back.identity ?? {})})`);
    await asUser(admin.id, `select public.bind_scale_to_connector(${lit(branch.id)}, ${lit(key)}, ${lit(conn.id)}, ${jsonLit(f.sent)})`);
    scaleKeys[family] = key;
    result.created.scales.push(key);
  }
  save();
  // Productos pesables reales de la empresa (como los arma Mis balanzas: sendPayload)
  products = await sql(`select id, code, name, unit, price_retail::float8 as price from products where company_id = ${lit(company.id)} and active and unit = 'kg' and code ~ '^[0-9]{1,4}$' and price_retail > 0 and price_retail = round(price_retail) order by code::int`);
  payload = {
    products: products.map((p) => ({ product_id: p.id, plu: p.code, name: p.name, unit: p.unit, price: p.price, active: true })),
    allow_replace: false,
    can_manage_links: true,
    weight_barcode: false,
    pesos_barcode: false,
    plu5_barcode: false,
  };
  log(`${products.length} productos pesables`);
  // La sucursal tiene DOS balanzas: el conector solo manda el 1070 de la Report por red si el formato de etiqueta de la
  // sucursal ya es ese (resguardo C1, igual que la web). Se deja como lo tendría un local que ya usa la Report por red
  // (2-5-5 con peso) y se vuelve al original al limpiar.
  const [cfg] = await sql(`select prefix_length, plu_length, weight_length, weight_divisor, total_length, payload_type from branch_scale_configs where company_id = ${lit(company.id)} and branch_id = ${lit(branch.id)}`);
  result.created.branchConfigOriginal = cfg ?? null;
  save();
  if (cfg) await sql(`update branch_scale_configs set prefix_length = 2, plu_length = 5, weight_length = 5, weight_divisor = 1000, total_length = 13, payload_type = 'weight', updated_at = now() where company_id = ${lit(company.id)} and branch_id = ${lit(branch.id)}`);
  else await sql(`insert into branch_scale_configs (company_id, branch_id, prefix_length, plu_length, weight_length, weight_divisor, total_length, payload_type, created_by) values (${lit(company.id)}, ${lit(branch.id)}, 2, 5, 5, 1000, 13, 'weight', ${lit(admin.id)})`);
  // Dos envíos A LA VEZ (una sola consulta)
  const [both] = await asUser(
    admin.id,
    `select public.queue_scale_job(${lit(scaleKeys.kretz)}, 'send', ${jsonLit(payload)}, ${lit(branch.id)}, ${lit(conn.id)}) as r, public.queue_scale_job(${lit(scaleKeys.systel)}, 'send', ${jsonLit(payload)}, ${lit(branch.id)}, ${lit(conn.id)}) as s`,
  );
  result.created.jobs.push(both.r, both.s);
  const [r, s] = await waitJobs([both.r, both.s]);
  result.phases.envioDoble = { report: r, systel: s, reportItems: await items(r.id), systelItems: await items(s.id) };
  save();
  log(`Fase 1: Report ${r.status} ${r.confirmed_count}/${r.requested_count}, Cuora ${s.status} ${s.confirmed_count}/${s.requested_count}`);
}

async function phase2() {
  await sleep(8000);
  const [both] = await asUser(
    admin.id,
    `select public.queue_scale_job(${lit(scaleKeys.kretz)}, 'send', ${jsonLit(payload)}, ${lit(branch.id)}, ${lit(conn.id)}) as r, public.queue_scale_job(${lit(scaleKeys.systel)}, 'send', ${jsonLit(payload)}, ${lit(branch.id)}, ${lit(conn.id)}) as s`,
  );
  result.created.jobs.push(both.r, both.s);
  const [r, s] = await waitJobs([both.r, both.s]);
  result.phases.corte = { report: r, systel: s, reportItems: await items(r.id), systelItems: await items(s.id) };
  save();
  log(`Fase 2: Report ${r.status} (${r.error_code}), Cuora ${s.status}`);
}

async function phase3() {
  // El workflow corta la red al empezar el paso y la deja cortada 150 s: se encola en el medio.
  await sleep(70_000);
  const [both] = await asUser(
    admin.id,
    `select now() as queued_at, public.queue_scale_job(${lit(scaleKeys.kretz)}, 'send', ${jsonLit(payload)}, ${lit(branch.id)}, ${lit(conn.id)}) as r, public.queue_scale_job(${lit(scaleKeys.systel)}, 'send', ${jsonLit(payload)}, ${lit(branch.id)}, ${lit(conn.id)}) as s`,
  );
  result.created.jobs.push(both.r, both.s);
  log("Fase 3: dos envíos encolados con la PC sin red");
  const [r, s] = await waitJobs([both.r, both.s], 25);
  result.phases.sinRed = { queuedAt: both.queued_at, report: r, systel: s, reportItems: await items(r.id), systelItems: await items(s.id) };
  save();
  log(`Fase 3: Report ${r.status}, Cuora ${s.status}`);
}

async function phase4() {
  await sleep(5000);
  const id = await queue(scaleKeys.kretz, "test", {}, conn.id);
  const [t] = await waitJobs([id], 12);
  result.phases.reinstalado = { test: t, items: await items(id) };
  save();
  log(`Fase 4: prueba de conexión ${t.status}`);
}

// ── seguir la corrida ─────────────────────────────────────────────────────────────────────────────────────────────
const handlers = [
  ["Vincular con staging", pairingCode],
  ["Fase 1", phase1],
  ["Fase 2", phase2],
  ["Fase 3", phase3],
  ["Fase 4", phase4],
];
const done = new Set();
let failed = null;
for (;;) {
  let info;
  try {
    info = await steps();
  } catch (error) {
    log("gh:", String(error).slice(0, 200));
    await sleep(10_000);
    continue;
  }
  for (const [prefix, fn] of handlers) {
    const step = info.steps.find((s) => s.name.startsWith(prefix));
    if (step?.status === "in_progress" && !done.has(prefix)) {
      done.add(prefix);
      log(`→ ${step.name}`);
      try {
        await fn();
      } catch (error) {
        failed = `${prefix}: ${error.message}`;
        log("ERROR", failed);
        check("Conductor", prefix, false, error.message);
      }
    }
  }
  if (info.job?.status === "completed") break;
  await sleep(5000);
}

// ── comparar con lo que quedó en cada balanza ─────────────────────────────────────────────────────────────────────
const [run] = [JSON.parse(gh(["run", "view", String(runId), "--json", "conclusion,url"]))];
result.workflow = run;
try {
  execFileSync("gh", ["run", "download", String(runId), "-D", path.join(outDir, "artefactos")], { cwd: projectDir, stdio: "inherit" });
} catch {
  log("No se pudieron bajar los artefactos");
}
const art = (name) => {
  const base = path.join(outDir, "artefactos");
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) {
    const f = path.join(base, d, name);
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, ""));
  }
  return null;
};
const ascii = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

function compareReport(sim, label) {
  const plus = new Map((sim?.report?.plus ?? []).map((p) => [p.plu, p]));
  const bad = [];
  for (const p of products) {
    const got = plus.get(Number(p.code));
    const name = ascii(p.name).slice(0, 26).trimEnd();
    if (!got) bad.push(`${p.code} falta`);
    else if (got.nombre !== name || got.precio !== p.price || !got.porPeso || got.codigo !== Number(p.code)) bad.push(`${p.code}: ${JSON.stringify(got)}`);
  }
  check("Envío doble", `${label}: la Report tiene exactamente PLU, nombre y precio de cada producto`, bad.length === 0 && plus.size === products.length, bad.slice(0, 5).join("; ") || `${plus.size} PLU`);
  const codes = sim?.report?.codigoDeBarras1070 ?? [];
  check("Envío doble", `${label}: la Report recibió el 1070 de la etiqueta por red (2-5-5 con peso)`, codes.length > 0 && codes.every((c) => c === "2112001"), codes.join(","));
}

function compareSystel(sim, label) {
  const plus = new Map((sim?.systel?.plus ?? []).filter((p) => p.plu !== 900).map((p) => [p.plu, p]));
  const bad = [];
  for (const p of products) {
    const got = plus.get(Number(p.code));
    const name = ascii(p.name).slice(0, 18).trim();
    if (!got) bad.push(`${p.code} falta`);
    else if (got.nombre !== name || got.precio !== p.price || got.tipo !== "P" || got.ean?.tipo !== 1 || got.ean?.formato !== "20PPPPCCCCCC") bad.push(`${p.code}: ${JSON.stringify(got)}`);
  }
  check("Envío doble", `${label}: la Cuora tiene exactamente PLU, nombre, precio y código de barras Systel (20PPPPCCCCCC) de cada producto`, bad.length === 0 && plus.size === products.length, bad.slice(0, 5).join("; ") || `${plus.size} PLU`);
}

function itemsMatch(jobItems, label, status) {
  const byPlu = new Map(jobItems.map((i) => [i.plu, i]));
  const ok = products.every((p) => byPlu.get(p.code)?.status === status && byPlu.get(p.code)?.product_id === p.id) && jobItems.length === products.length;
  check("Envío doble", `${label}: scale_job_items tiene cada producto (PLU y producto) como ${status}`, ok, `${jobItems.length} filas`);
}

const p1 = result.phases.envioDoble;
const sim1 = art("simuladores-fase1.json");
if (p1) {
  check("Envío doble", "Report: el envío terminó bien", p1.report.status === "done", `${p1.report.status} ${p1.report.error_code ?? ""} ${p1.report.confirmed_count}/${p1.report.requested_count}`);
  check("Envío doble", "Cuora: el envío terminó bien", p1.systel.status === "done", `${p1.systel.status} ${p1.systel.confirmed_count}/${p1.systel.requested_count}`);
  const a = p1.report, b = p1.systel;
  check("Envío doble", "Los dos envíos corrieron a la vez", new Date(a.claimed_at) < new Date(b.finished_at) && new Date(b.claimed_at) < new Date(a.finished_at), `Report ${a.claimed_at}→${a.finished_at}, Cuora ${b.claimed_at}→${b.finished_at}`);
  itemsMatch(p1.reportItems, "Report", "confirmed");
  itemsMatch(p1.systelItems, "Cuora", "confirmed");
  if (sim1) {
    compareReport(sim1, "Fase 1");
    compareSystel(sim1, "Fase 1");
  } else check("Envío doble", "Estado de los simuladores (artefacto)", false, "no está simuladores-fase1.json");
}
const p2 = result.phases.corte;
if (p2) {
  check("Fallas", "Report cortada a mitad: NO termina done", p2.report.status !== "done" && ["failed", "partial"].includes(p2.report.status), `${p2.report.status} (${p2.report.error_code}), confirmados ${p2.report.confirmed_count}, fallados ${p2.report.failed_count}`);
  check("Fallas", "Report cortada: informa el resultado de cada producto", p2.reportItems.length === products.length && p2.reportItems.some((i) => i.status === "failed" && i.reason), `${p2.reportItems.length} filas`);
  check("Fallas", "Cuora: termina bien aunque la otra se cortó", p2.systel.status === "done" && p2.systel.confirmed_count === products.length, `${p2.systel.status} ${p2.systel.confirmed_count}/${products.length}`);
  const sim2 = art("simuladores-fase2.json");
  if (sim2) compareSystel(sim2, "Fase 2");
}
const p3 = result.phases.sinRed;
if (p3) {
  const cut = art("corte-de-red.json");
  check("Reconexión", "Encolados mientras la PC no tenía red", cut && new Date(p3.queuedAt) > new Date(cut.bloqueado) && new Date(p3.queuedAt) < new Date(cut.desbloqueado), cut ? `red cortada ${cut.bloqueado} → ${cut.desbloqueado}, encolados ${p3.queuedAt}` : "sin corte-de-red.json");
  check("Reconexión", "Los tomó recién al volver la red", cut && [p3.report, p3.systel].every((j) => new Date(j.claimed_at) >= new Date(cut.desbloqueado)), `${p3.report.claimed_at}, ${p3.systel.claimed_at}`);
  check("Reconexión", "Y terminaron bien", p3.report.status === "done" && p3.systel.status === "done", `${p3.report.status} / ${p3.systel.status}`);
  const sim3 = art("simuladores-fase3.json");
  if (sim3) {
    compareReport(sim3, "Fase 3");
    compareSystel(sim3, "Fase 3");
  }
}
const p4 = result.phases.reinstalado;
if (p4) check("Recuperación", "Después de reinstalar: prueba de conexión por la nube", p4.test.status === "done", `${p4.test.status} ${p4.items?.[0]?.reason ?? ""}`);
check("Workflow", "La corrida de GitHub terminó en verde", run.conclusion === "success", `${run.conclusion} ${run.url}`);
save();
const bad = result.checks.filter((c) => !c.ok);
log(bad.length ? `${bad.length} comprobaciones fallaron` : "Todo dio bien", path.join(outDir, "resultado.json"));
process.exit(bad.length || failed ? 1 : 0);
