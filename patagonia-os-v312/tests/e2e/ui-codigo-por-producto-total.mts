// Pantalla REAL del Mostrador contra STAGING (Don Julio), SIN balanza conectada: así trabajaría Los gringos
// cuando su Systel imprima el código de cada producto (20/21 + producto + cantidad de 6 cifras).
// REAL: los tickets 3095 y 3087 del 13/10 (artículos, cantidades e importes del reporte de su balanza), sus
// precios de lista 1 y 2 (registros 62 del 14/10) y el formato del TOTAL (22AA + importe).
// SIMULADO: los códigos de cada artículo (todavía no los imprime) y los productos espejo PRUEBA 9002/9005/9010/9012
// (en Don Julio los códigos 2, 5, 10 y 12 ya existen), sin precio en Patagonia como en el cliente (salvo 9002/9005).
// Antes: npm run dev:staging -w @patagonia/web -- --port 5194 --strictPort
// Corre desde patagonia-os-v312: npx tsx tests/e2e/ui-codigo-por-producto-total.mts
import fs from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(fs.readFileSync(new URL("../../.env.demo-staging", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const sb = createClient(env.DEMO_SUPABASE_URL, env.DEMO_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await sb.auth.signInWithPassword({ email: env.DEMO_OWNER_EMAIL, password: env.DEMO_OWNER_PASSWORD });
const branchId = env.DEMO_BRANCH_ID;
const prod = async (code: string) => (await sb.from("products_with_stock").select("id, code, name, unit, price_retail, stock").eq("branch_id", branchId).eq("code", code).single()).data as any;
const ean = (first12: string) => {
  const s = first12.split("").map(Number).reduce((a, d, i) => a + d * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (s % 10)) % 10);
};

// Corridas anteriores de esta prueba: se anulan sus ventas.
const { data: prev } = await sb.from("pos_sale_items").select("sale_id, pos_sales!inner(voided_at, branch_id)").like("scale_ticket", "systel-total:%").is("pos_sales.voided_at", null).eq("pos_sales.branch_id", branchId);
for (const id of new Set((prev ?? []).map((r: any) => r.sale_id))) await sb.rpc("void_pos_sale", { p_sale_id: id });
for (const [code, qty] of [["9002", 10], ["9005", 20], ["9010", 20], ["9012", 10]] as const) {
  const p = await prod(code);
  await sb.rpc("adjust_product_stock", { p_branch_id: branchId, p_product_id: p.id, p_counted_quantity: qty, p_reason: "Prueba código por producto + TOTAL (staging)" });
}
const stock = async () => Object.fromEntries(await Promise.all(["9002", "9005", "9010", "9012"].map(async (c) => [c, Number((await prod(c)).stock)])));
const before = await stock();
console.log("Stock antes:", JSON.stringify(before));

// Lo que guarda el diagnóstico en esa PC: formatos y precios REALES de la balanza (con los códigos espejo).
const TEMPLATES = {
  weighed: "20PPPPCCCCCC", unit: "21PPPPCCCCCC", sums: "22AAIIIIIIII", at: Date.now(),
  perPlu: {
    "9002": { type: 1, config: "21PPPPCCCCCC", p1: 72000, p2: 68000, name: "GRINGO CAJON DE", saleType: "U" },
    "9005": { type: 1, config: "20PPPPCCCCCC", p1: 5200, p2: 4700, name: "TROZADITOx1x2", saleType: "P" },
    "9010": { type: 1, config: "20PPPPCCCCCC", p1: 7400, p2: 7200, name: "PECHUGAC/H x1x5", saleType: "P" },
    "9012": { type: 1, config: "21PPPPCCCCCC", p1: 106000, p2: 103000, name: "CAJON PECH.C/Hx1", saleType: "U" }
  }
};

const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
let dialogAnswer = true;
const promptAnswers: string[] = [];
p.on("dialog", (d) => (d.type() === "prompt" ? d.accept(promptAnswers.shift() ?? "") : dialogAnswer ? d.accept() : d.dismiss()));
p.on("pageerror", (e) => console.log("[error página]", String(e).slice(0, 300)));
await p.addInitScript(`localStorage.setItem("patagonia-systel-label-templates", ${JSON.stringify(JSON.stringify(TEMPLATES))});`);
await p.goto("http://localhost:5194/");
await p.getByLabel(/mail/i).fill(env.DEMO_OWNER_EMAIL);
await p.getByLabel(/contraseña|clave/i).fill(env.DEMO_OWNER_PASSWORD);
await p.getByRole("button", { name: /ingresar|entrar/i }).click();
await p.waitForTimeout(3500);
await p.getByRole("button", { name: /^Mostrador$/ }).first().click();
await p.waitForTimeout(2500);
const box = p.getByPlaceholder(/Escane|Buscar|código/i).first();
const lines = async () => (await p.locator(".pos-cart-row").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
const msg = async () => ((await p.locator("body").innerText()).split("\n").find((l) => /Agregado:|Importes confirmados|No se confirmaron|Falta escanear|ya estaba cobrado|TOTAL/.test(l)) ?? "(sin mensaje)").trim();
const scan = async (code: string) => {
  await box.fill(code);
  await box.press("Enter");
  await p.waitForTimeout(900);
};
const charge = async () => {
  await p.getByRole("button", { name: /Efectivo/ }).first().click();
  await p.getByPlaceholder(/Recibiste/).first().fill("300000");
  await p.getByRole("button", { name: /^(Cobrar|Confirmar cobro)/ }).first().click();
  await p.waitForTimeout(800);
  if (await p.getByRole("button", { name: /^Confirmar cobro/ }).count()) await p.getByRole("button", { name: /^Confirmar cobro/ }).first().click();
  await p.waitForTimeout(3500);
};
const lastSale = async () => {
  const { data: sale } = await sb.from("pos_sales").select("id, total").eq("branch_id", branchId).order("created_at", { ascending: false }).limit(1).single();
  const { data: items } = await sb.from("pos_sale_items").select("quantity, line_total, scale_ticket, products(code)").eq("sale_id", (sale as any).id);
  return { total: (sale as any).total, items: (items ?? []).map((i: any) => `${i.products.code} ${i.quantity} $${i.line_total}`) };
};

console.log("\n[1] Ticket REAL 3095 (foto): códigos de CAJON 1 u. y TROZADITO 0,215 kg");
await scan(ean("219002000001"));
await scan(ean("209005000215"));
console.log("  ", await msg(), "\n   líneas:", JSON.stringify(await lines()));
console.log("[1b] Intento cobrar SIN el TOTAL:");
await p.getByRole("button", { name: /Efectivo/ }).first().click();
await p.getByRole("button", { name: /^(Cobrar|Confirmar cobro)/ }).first().click();
await p.waitForTimeout(600);
console.log("  ", await msg());
console.log("[1c] Escaneo el TOTAL REAL 2202000731184 ($73.118, 2 artículos):");
await scan("2202000731184");
console.log("  ", await msg(), "\n   líneas:", JSON.stringify(await lines()));
await charge();
console.log("   venta guardada:", JSON.stringify(await lastSale()));

console.log("\n[2] Ticket REAL 3087: PECHUGA C/H 0,145 kg (lista 1) + CAJON PECHUGA 1 u. (lista 1) + CAJON GRINGO 1 u. (LISTA 2)");
await scan(ean("209010000145"));
await scan(ean("219012000001"));
await scan(ean("219002000001"));
await scan(ean("220300175073"));
console.log("  ", await msg(), "\n   líneas:", JSON.stringify(await lines()));
await charge();
console.log("   venta guardada:", JSON.stringify(await lastSale()));

console.log("\n[3] Mismo papel del ticket 3095 escaneado otra vez en otra venta (se contesta 'Cancelar' al aviso):");
dialogAnswer = false;
await scan(ean("219002000001"));
await scan(ean("209005000215"));
await scan("2202000731184");
console.log("  ", await msg());
await p.getByRole("button", { name: /Cancelar ticket/ }).first().click();
await p.waitForTimeout(500);

console.log("\n[3b] Ticket REAL con precio MANUAL (13/10: dos cajones a $74.000 y $70.000 = $144.000): no adivina, pide el importe del papel");
dialogAnswer = true;
promptAnswers.push("74000", "70000");
await scan(ean("219002000001"));
await scan(ean("219002000001"));
await scan(ean("220200144000"));
console.log("  ", await msg(), "\n   líneas:", JSON.stringify(await lines()));
await charge();
console.log("   venta guardada:", JSON.stringify(await lastSale()));

console.log("\n[4] Falta un artículo: el TOTAL dice 2 y se escaneó 1:");
await scan(ean("209005000215"));
await scan("2202000731184");
console.log("  ", await msg());
await p.getByRole("button", { name: /Cancelar ticket/ }).first().click();
await b.close();

const after = await stock();
console.log("\nStock después:", JSON.stringify(after));
console.log("Diferencia:", JSON.stringify(Object.fromEntries(Object.keys(after).map((k) => [k, Math.round((after[k] - before[k]) * 1000) / 1000]))));
