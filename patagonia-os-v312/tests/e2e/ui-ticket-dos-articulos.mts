// Pantalla REAL del Mostrador contra STAGING (Don Julio), con el ticket REAL de 2 artículos de Los gringos
// (13/10, op. 20-3095): GRINGO CAJON 1 un $72.000 + TROZADITO 0,215 kg $1.118 = TOTAL $73.118.
// - Escanea el código REAL del TOTAL (2202000731184): no tiene que agregar nada.
// - Escanea el código REAL en blanco de cada artículo (0000000000000): no tiene que agregar nada.
// - Escanea los códigos por artículo que imprime la balanza con "USAR EAN GRAL." (formato leído de esa
//   balanza: 20PPPPCCCCCC / 21PPPPCCCCCC), con productos espejo PRUEBA 9002 / 9005 y los mismos precios.
// - Cobra y muestra producto, cantidad, importe y stock antes/después de cada uno.
// Antes: sucursal de staging con formato Systel (2/4/6/1000/13) y
//        npm run dev:staging -w @patagonia/web -- --port 5194 --strictPort
// Corre desde patagonia-os-v312: npx tsx tests/e2e/ui-ticket-dos-articulos.mts
import fs from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(fs.readFileSync(new URL("../../.env.demo-staging", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const sb = createClient(env.DEMO_SUPABASE_URL, env.DEMO_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await sb.auth.signInWithPassword({ email: env.DEMO_OWNER_EMAIL, password: env.DEMO_OWNER_PASSWORD });
const branchId = env.DEMO_BRANCH_ID;
const prod = async (code: string) => (await sb.from("products_with_stock").select("id, code, name, unit, price_retail, stock").eq("branch_id", branchId).eq("code", code).single()).data as any;

const ean = (first12: string) => {
  const sum = first12.split("").map(Number).reduce((a, d, i) => a + d * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
};
const TOTAL_REAL = "2202000731184";
const BLANK_REAL = "0000000000000";
const CAJON = ean("219002000001");
const TROZ = ean("209005000215");

for (const [code, qty] of [["9002", 10], ["9005", 20]] as const) {
  const p = await prod(code);
  await sb.rpc("adjust_product_stock", { p_branch_id: branchId, p_product_id: p.id, p_counted_quantity: qty, p_reason: "Prueba ticket de 2 artículos (staging)" });
}
const before = { cajon: Number((await prod("9002")).stock), troz: Number((await prod("9005")).stock) };
console.log(`Stock antes: CAJON ${before.cajon} u. · TROZADITO ${before.troz} kg`);

const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
p.on("dialog", (d) => d.accept());
await p.goto("http://localhost:5194/");
await p.getByLabel(/mail/i).fill(env.DEMO_OWNER_EMAIL);
await p.getByLabel(/contraseña|clave/i).fill(env.DEMO_OWNER_PASSWORD);
await p.getByRole("button", { name: /ingresar|entrar/i }).click();
await p.waitForTimeout(3500);
await p.getByRole("button", { name: /^Mostrador$/ }).first().click();
await p.waitForTimeout(2500);
const box = p.getByPlaceholder(/Escane|Buscar|código/i).first();
const lines = async () => (await p.locator(".pos-cart-row, .pos-ticket-line, tr").allInnerTexts()).filter((t) => /PRUEBA|Ticket de balanza/.test(t)).map((t) => t.replace(/\s+/g, " "));
const scan = async (code: string, label: string) => {
  await box.fill(code);
  await box.press("Enter");
  await p.waitForTimeout(700);
  const msg = (await p.locator("body").innerText()).split("\n").find((l) => /Agregado|TOTAL del ticket|No se encontr|no se agreg/i.test(l)) ?? "(sin mensaje)";
  console.log(`\n[${label}] ${code}\n  mensaje: ${msg.trim()}\n  líneas del ticket: ${JSON.stringify(await lines())}`);
};
await scan(TOTAL_REAL, "TOTAL real del ticket");
await scan(BLANK_REAL, "código real en blanco de un artículo");
await scan(CAJON, "artículo 1 con EAN general: 21 9002 000001");
await scan(TROZ, "artículo 2 con EAN general: 20 9005 000215");
await p.screenshot({ path: "tests/e2e/ui-ticket-dos-articulos.png" });
console.log("\nTotal en pantalla:", ((await p.locator("body").innerText()).match(/Total[^\n]*\n?[^\n]*\$\s?[\d.]+/) ?? ["?"])[0].replace(/\s+/g, " "));
await p.getByRole("button", { name: /Efectivo/ }).first().click();
await p.getByPlaceholder(/Recibiste/).first().fill("80000");
await p.getByRole("button", { name: /^(Cobrar|Confirmar cobro)/ }).first().click();
await p.waitForTimeout(800);
if (await p.getByRole("button", { name: /^Confirmar cobro/ }).count()) await p.getByRole("button", { name: /^Confirmar cobro/ }).first().click();
await p.waitForTimeout(3500);
await b.close();

const after = { cajon: Number((await prod("9002")).stock), troz: Number((await prod("9005")).stock) };
const { data: sale } = await sb.from("pos_sales").select("id, total, branch_id, created_at").eq("branch_id", branchId).order("created_at", { ascending: false }).limit(1).single();
const { data: items } = await sb.from("pos_sale_items").select("product_id, quantity, unit_price, line_total, source").eq("sale_id", (sale as any).id);
const { data: movs } = await sb.from("inventory_movements").select("product_id, quantity, movement_type, branch_id").eq("reference_id", (sale as any).id);
console.log(`\nVenta ${(sale as any).id.slice(0, 8)}… total $${(sale as any).total} · sucursal correcta: ${(sale as any).branch_id === branchId}`);
console.log("Renglones:", JSON.stringify(items));
console.log("Movimientos de stock:", JSON.stringify(movs));
console.log(`CAJON: ${before.cajon} → ${after.cajon} u. (−${before.cajon - after.cajon})`);
console.log(`TROZADITO: ${before.troz} → ${after.troz} kg (−${(before.troz - after.troz).toFixed(3)})`);
