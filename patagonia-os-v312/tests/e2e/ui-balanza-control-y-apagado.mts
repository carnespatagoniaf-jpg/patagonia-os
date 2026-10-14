// STAGING, empresa aislada "PRUEBA Balanzas": (4) probar un código impreso sin vender, (5) el stock no cambia al
// escanear, solo al cobrar, (6) el interruptor apaga la venta con balanza sin borrar nada y sin perder ventas.
// Antes (desde apps/web): npx vite --mode staging --port 5195 --strictPort
import fs from "node:fs";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { buildCode, parseTemplate } from "../../apps/web/src/features/scales/sale/label-template";

const readEnv = (p: string) => Object.fromEntries(fs.readFileSync(new URL(p, import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const env = readEnv("../../.env.balanzas-staging");
const anon = readEnv("../../.env.demo-staging").DEMO_SUPABASE_ANON_KEY;
const sb = createClient(env.BAL_SUPABASE_URL, anon, { auth: { persistSession: false } });
await sb.auth.signInWithPassword({ email: env.BAL_EMAIL, password: env.BAL_PASSWORD });
const branch = env.BAL_BRANCH_ID;
let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "OK  " : "FALLA"} ${msg}`);
  if (!cond) failures++;
};
const salt = (1 + Math.floor(Math.random() * 400)) / 1000;
const kg = Math.round((0.6 + salt) * 1000) / 1000;
const item = (code: number, q: number, unit = false) => buildCode(parseTemplate(unit ? "21PPPPCCCCCC" : "20PPPPCCCCCC")!, { P: code, C: unit ? q : Math.round(q * 1000) })!;
const total = (a: number, amount: number) => buildCode(parseTemplate("22AAIIIIIIII")!, { A: a, I: amount })!;
const stockOf = async (code: string) => Number((await sb.from("products_with_stock").select("stock").eq("branch_id", branch).eq("code", code).single()).data!.stock);
const movements = async () => (await sb.from("inventory_movements").select("id", { count: "exact", head: true }).eq("branch_id", branch)).count ?? 0;

const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1400, height: 1100 } });
p.on("dialog", (d) => void d.accept());
await p.goto("http://localhost:5195/");
await p.getByLabel(/mail/i).fill(env.BAL_EMAIL);
await p.getByLabel(/contraseña|clave/i).fill(env.BAL_PASSWORD);
await p.getByRole("button", { name: /ingresar|entrar/i }).click();
await p.waitForTimeout(3500);
const line = async (re: RegExp) => ((await p.locator("body").innerText()).split("\n").find((l) => re.test(l)) ?? "(sin mensaje)").trim();

// 4. Probar un código impreso (Stock → Balanza): solo muestra cómo lo lee.
await p.getByRole("button", { name: "Stock", exact: true }).click();
await p.waitForTimeout(2500);
await p.getByRole("button", { name: /^Balanza$/ }).first().click();
await p.waitForTimeout(2500);
const m0 = await movements();
const probe = p.getByPlaceholder("Código de barras");
for (const [code, re, what] of [
  [item(8, 14.935), /PATA MUSLOx5x10.*14,935 kg → descuenta stock de "PRUEBA PATA MUSLOx5x10".*\$3\.600 \/ \$3\.400/, "pesable de más de 10 kg"],
  [item(2, 1, true), /GRINGO CAJON DE.*1 unidad\(es\) → descuenta stock de "PRUEBA GRINGO CAJON DE"/, "unitario"],
  ["2202000731184", /TOTAL del ticket: \$73\.118, 2 artículo/, "TOTAL real"],
  [item(5, 0.215).slice(0, 12) + "0", /No se puede usar: el código se leyó con un error|No es un código/, "código mal leído"]
] as const) {
  await probe.fill(code);
  await probe.press("Enter");
  await p.waitForTimeout(300);
  const t = await line(/TOTAL del ticket|unidad\(es\)|kg →|No se puede usar|No es un código/);
  check(re.test(t), `probar código (${what}): ${t}`);
}
check((await movements()) === m0, "probar códigos no movió el stock");

// 5. Mostrador: escanear no toca el stock; cobrar lo descuenta una vez.
await p.getByRole("button", { name: /^Mostrador$/ }).first().click();
await p.waitForTimeout(3000);
const box = p.getByPlaceholder(/Escane|Buscar|código/i).first();
const scan = async (c: string) => { await box.fill(c); await box.press("Enter"); await p.waitForTimeout(700); };
const s0 = await stockOf("5");
await scan(item(5, kg));
await scan(total(1, Math.round(kg * 5200)));
check(/confirmado/.test(await line(/confirmado|No se confirmó/)) && (await stockOf("5")) === s0, `ticket escaneado y confirmado, todavía sin cobrar: stock ${await stockOf("5")} (antes ${s0}, sin cambios)`);
await p.getByRole("button", { name: /Efectivo/ }).first().click();
await p.getByPlaceholder(/Recibiste/).first().fill("100000");
await p.getByRole("button", { name: /^(Cobrar|Confirmar cobro)/ }).first().click();
await p.waitForTimeout(700);
if (await p.getByRole("button", { name: /^Confirmar cobro/ }).count()) await p.getByRole("button", { name: /^Confirmar cobro/ }).first().click();
await p.waitForTimeout(3500);
check(Math.round(((await stockOf("5")) - (s0 - kg)) * 1000) === 0, `al cobrar: stock ${await stockOf("5")} = ${s0} − ${kg} (una sola vez)`);

// 6. Interruptor: apagar desde la pantalla. No se borra nada; Mostrador deja de usar la balanza nueva.
const { count: claimsBefore } = await sb.from("pos_scale_paper_claims").select("id", { count: "exact", head: true }).eq("branch_id", branch);
await p.getByRole("button", { name: "Stock", exact: true }).click();
await p.waitForTimeout(2500);
await p.getByRole("button", { name: /^Balanza$/ }).first().click();
await p.waitForTimeout(2500);
await p.getByRole("button", { name: /^Apagar$/ }).click();
await p.waitForTimeout(2500);
check(/apagada/.test(await line(/Venta con balanza en Mostrador/)), `interruptor: ${await line(/Venta con balanza en Mostrador/)}`);
const { data: prof } = await sb.from("scale_profiles").select("active").eq("branch_id", branch).single();
const { count: claimsAfter } = await sb.from("pos_scale_paper_claims").select("id", { count: "exact", head: true }).eq("branch_id", branch);
const { count: catalog } = await sb.from("scale_catalog_items").select("code", { count: "exact", head: true }).eq("branch_id", branch);
check(prof?.active === false && claimsAfter === claimsBefore && (catalog ?? 0) > 0, `apagada sin borrar nada: papeles ${claimsAfter} (antes ${claimsBefore}), catálogo ${catalog} productos`);
await p.getByRole("button", { name: /^Mostrador$/ }).first().click();
await p.waitForTimeout(3000);
await scan(item(5, kg));
check(!(await p.locator("body").innerText()).includes("Esperando el TOTAL"), "con la venta con balanza apagada, Mostrador ya no arma papeles (funciona como antes)");
if (await p.getByRole("button", { name: /Cancelar ticket/ }).count()) await p.getByRole("button", { name: /Cancelar ticket/ }).first().click();
// Una venta con papel que quedó guardada sin conexión ANTES de apagar: se sube igual (no se pierde).
const { data: shift } = await sb.from("pos_shifts").select("id").eq("branch_id", branch).eq("status", "open").single();
const { data: p5 } = await sb.from("products_with_stock").select("id").eq("branch_id", branch).eq("code", "5").single();
const offKg = Math.round((0.3 + salt) * 1000) / 1000;
const amount = Math.round(offKg * 5200);
const queued = await sb.rpc("create_pos_scale_sale", {
  p_branch_id: branch, p_items: [{ product_id: p5!.id, quantity: offKg, discount_amount: 0, source: "scale", scale_tickets: 1, scale_amount: amount, scale_ticket: `cola-${crypto.randomUUID()}#0`, scale_code: 5 }],
  p_payments: [{ account_id: env.BAL_CASH_ACCOUNT_ID, amount, reference: null }], p_pos_shift_id: shift!.id, p_discount_amount: 0, p_surcharge_amount: 0,
  p_idempotency_key: crypto.randomUUID(), p_scale_key: "systel-20",
  p_papers: [{ fingerprint: `cola-${crypto.randomUUID()}`, ticket_date: new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10), total: amount, articles: 1, repeat_confirmed: false, items: [0] }]
});
check(!queued.error, `venta guardada sin conexión antes de apagar: se sube igual con la función apagada (${queued.error?.message ?? "subida"})`);
// Volver a encender.
await p.getByRole("button", { name: "Stock", exact: true }).click();
await p.waitForTimeout(2500);
await p.getByRole("button", { name: /^Balanza$/ }).first().click();
await p.waitForTimeout(2500);
await p.getByRole("button", { name: /^Encender$/ }).click();
await p.waitForTimeout(2500);
check(/encendida/.test(await line(/Venta con balanza en Mostrador/)), `volver a encender: ${await line(/Venta con balanza en Mostrador/)}`);
const { data: audit } = await sb.from("audit_log").select("action, new_data").eq("branch_id", branch).eq("action", "scale_profile.active").order("created_at", { ascending: false }).limit(2);
check((audit ?? []).length === 2, `quedó en auditoría: ${(audit ?? []).map((a: any) => JSON.stringify(a.new_data)).join(" · ")}`);
await b.close();
console.log(failures === 0 ? "\nTODO OK" : `\n${failures} FALLAS`);
