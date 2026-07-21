// Smoke tests de Patagonia OS. Corren contra un sitio real (local o
// deployado) y una cuenta real de Supabase — no mockean nada, porque los
// bugs reales de esta sesión (dinero vs. cantidad mal parseados, la
// carrera de login) solo se ven así. A proposito NO mutan datos (no crean
// ni ajustan stock, no crean usuarios) para poder correrse las veces que
// haga falta contra una base real sin dejar basura ni arriesgar datos.
//
// Uso: copiar .env.test.example a .env.test, completar credenciales, y
// correr `npm run test:e2e` (con `npm run dev` corriendo aparte si se
// prueba localhost).

import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(rootDir, ".env.test"));

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:5173";
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

if (!OWNER_EMAIL || !OWNER_PASSWORD) {
  console.log("[test:e2e] Faltan E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD — copiá .env.test.example a .env.test y completalo. Salteando.");
  process.exit(0);
}

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
    console.log(`  FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await chromium.launch();

async function login(page, email, password) {
  await page.goto(BASE_URL);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForTimeout(2500);
}

await check("login con credenciales validas entra a la app", async () => {
  const page = await browser.newPage();
  await login(page, OWNER_EMAIL, OWNER_PASSWORD);
  const body = await page.textContent("body");
  assert(body?.includes("PATAGONIA OS"), "no se ve la marca del sidebar tras loguearse");
  assert(!body?.includes("Iniciar sesión"), "se quedó en la pantalla de login");
  assert(!body?.includes("No se encontró tu perfil"), "el perfil no cargó (regresión de la carrera de login)");
  await page.close();
});

await check("login con contraseña incorrecta muestra error y no entra", async () => {
  const page = await browser.newPage();
  await login(page, OWNER_EMAIL, "contraseña-incorrecta-a-proposito");
  const body = await page.textContent("body");
  assert(body?.includes("Iniciar sesión"), "debería seguir en la pantalla de login");
  await page.close();
});

await check("dashboard no muestra aviso de permiso denegado", async () => {
  const page = await browser.newPage();
  await login(page, OWNER_EMAIL, OWNER_PASSWORD);
  const body = await page.textContent("body");
  assert(!body?.includes("No tenés permiso para ver esta sección"), "el dashboard no debería estar bloqueado para ningún rol");
  await page.close();
});

if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  await check("login como platform admin muestra el alta de clientes (no rebota a login)", async () => {
    const page = await browser.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const body = await page.textContent("body");
    assert(body?.includes("Dar de alta un cliente"), "no se ve la pantalla de admin — ¿rebotó a login?");
    await page.close();
  });
} else {
  console.log("  skip login de platform admin (E2E_ADMIN_EMAIL/PASSWORD no configurados)");
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} smoke tests OK`);
if (failed.length > 0) {
  process.exit(1);
}
