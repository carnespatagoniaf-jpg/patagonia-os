// Pantalla REAL del Mostrador contra STAGING. Antes: npm run dev:staging -w @patagonia/web -- --port 5192 --strictPort
// Pantalla REAL del Mostrador contra STAGING: escanear etiquetas reales, cobrar y ver el stock en la base.
import fs from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

// Corre desde la carpeta patagonia-os-v312: npx tsx tests/e2e/ui-balanza-stock.mts (staging, empresa ficticia Don Julio).
const env = Object.fromEntries(fs.readFileSync(new URL("../../.env.demo-staging", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const sb = createClient(env.DEMO_SUPABASE_URL, env.DEMO_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await sb.auth.signInWithPassword({ email: env.DEMO_OWNER_EMAIL, password: env.DEMO_OWNER_PASSWORD });
const branchId = env.DEMO_BRANCH_ID;
const stock = async (code: string) => {
  const { data } = await sb.from("products_with_stock").select("code, stock").eq("branch_id", branchId).eq("code", code).single();
  return Number((data as any).stock);
};

// Formato de etiqueta de la sucursal = el de la balanza Kretz de Carnes Patagonia (1-6-5), igual que "Calibrar".
await sb.rpc("save_branch_scale_config", { p_branch_id: branchId, p_prefix_length: 1, p_plu_length: 6, p_weight_length: 5, p_weight_divisor: 1000, p_total_length: 13, p_payload_type: "weight" });
await sb.rpc("adjust_product_stock", { p_branch_id: branchId, p_product_id: (await sb.from("products_with_stock").select("id").eq("branch_id", branchId).eq("code", "2").single()).data!.id, p_counted_quantity: 15, p_reason: "Prueba pantalla balanza (staging)" });

const lines: string[] = [];
const log = (s: string) => { lines.push(s); console.log(s); };
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
p.on("dialog", (d) => d.accept());
await p.goto("http://localhost:5192/");
await p.getByLabel(/mail/i).fill(env.DEMO_OWNER_EMAIL);
await p.getByLabel(/contraseña|clave/i).fill(env.DEMO_OWNER_PASSWORD);
await p.getByRole("button", { name: /ingresar|entrar/i }).click();
await p.waitForTimeout(3500);
await p.getByRole("button", { name: /^Mostrador$/ }).first().click();
await p.waitForTimeout(2500);
const box = p.getByPlaceholder(/Escane|Buscar|código/i).first();
const msg = async () => ((await p.locator("body").innerText()).match(/(Agregado:[^\n]*|La etiqueta[^\n]*|No se encontró[^\n]*|no tiene precio[^\n]*)/) ?? ["(sin mensaje)"])[0];

const before = { asado: await stock("1"), vacio: await stock("2") };
log(`Stock antes  · 1 Asado: ${before.asado} kg · 2 Vacío: ${before.vacio} kg`);

for (const code of ["2000001019665", "2000002009429"]) { // REALES: producto 1 1,966 kg; producto 2 0,942 kg
  await box.fill(code);
  await box.press("Enter");
  await p.waitForTimeout(700);
  log(`Escaneo ${code} → ${await msg()}`);
}
for (const code of ["2000504011722", "2000001019666"]) { // REAL de un producto que no existe acá; REAL con un dígito cambiado
  await box.fill(code);
  await box.press("Enter");
  await p.waitForTimeout(700);
  log(`Escaneo ${code} → ${await msg()}`);
}
await p.screenshot({ path: "tests/e2e/ui-carrito.png" });
const mid = { asado: await stock("1"), vacio: await stock("2") };
log(`Stock con el ticket armado, SIN cobrar · Asado: ${mid.asado} · Vacío: ${mid.vacio}`);

await p.getByRole("button", { name: /Efectivo/ }).first().click();
await p.waitForTimeout(400);
await p.getByPlaceholder(/Recibiste/).first().fill("50000");
await p.waitForTimeout(300);
const charge = p.getByRole("button", { name: /^(Cobrar|Confirmar cobro)/ }).first();
await charge.click();
await p.waitForTimeout(800);
if (await p.getByRole("button", { name: /^Confirmar cobro/ }).count()) await p.getByRole("button", { name: /^Confirmar cobro/ }).first().click();
await p.waitForTimeout(3500);
await p.screenshot({ path: "tests/e2e/ui-cobrado.png" });
const after = { asado: await stock("1"), vacio: await stock("2") };
log(`Stock después de cobrar · Asado: ${after.asado} kg (−${(before.asado - after.asado).toFixed(3)}) · Vacío: ${after.vacio} kg (−${(before.vacio - after.vacio).toFixed(3)})`);

const { data: sale } = await sb.from("pos_sales").select("id, total, branch_id, created_at").eq("branch_id", branchId).order("created_at", { ascending: false }).limit(1).single();
const { data: items } = await sb.from("pos_sale_items").select("product_id, quantity, unit_price, line_total, source").eq("sale_id", (sale as any).id);
const { data: movs } = await sb.from("inventory_movements").select("product_id, quantity, movement_type, branch_id").eq("reference_id", (sale as any).id);
log(`Venta ${(sale as any).id} · total $${(sale as any).total} · sucursal ok: ${(sale as any).branch_id === branchId}`);
log(`  renglones: ${JSON.stringify(items)}`);
log(`  movimientos de stock: ${JSON.stringify(movs)}`);
await b.close();
