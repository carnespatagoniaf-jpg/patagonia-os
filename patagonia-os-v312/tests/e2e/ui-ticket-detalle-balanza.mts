// Pantalla REAL del Mostrador contra STAGING (Don Julio) + balanza Systel SIMULADA dentro del navegador
// (Web Serial falso que contesta según el protocolo: 23 ping y 72 reporte de ventas).
// REAL: el código del TOTAL escaneado (2202000731184, foto del ticket de Los gringos 13/10, op. 20-3095)
//       y los artículos/importes de ese ticket (cajón 1 un $72.000 + trozadito 0,215 kg $1.118).
// SIMULADO: la respuesta de la función 72 (armada con el formato del documento; nunca se leyó una real),
//       el N.º de ticket y vendedor, y los productos espejo PRUEBA 9002 / 9005 (en Don Julio el 2 y el 5 ya existen).
// Antes: npm run dev:staging -w @patagonia/web -- --port 5194 --strictPort
// Corre desde patagonia-os-v312: npx tsx tests/e2e/ui-ticket-detalle-balanza.mts
import fs from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(fs.readFileSync(new URL("../../.env.demo-staging", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const sb = createClient(env.DEMO_SUPABASE_URL, env.DEMO_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await sb.auth.signInWithPassword({ email: env.DEMO_OWNER_EMAIL, password: env.DEMO_OWNER_PASSWORD });
const branchId = env.DEMO_BRANCH_ID;
const prod = async (code: string) => (await sb.from("products_with_stock").select("id, code, name, unit, price_retail, stock").eq("branch_id", branchId).eq("code", code).single()).data as any;

for (const [code, qty] of [["9002", 10], ["9005", 20]] as const) {
  const p = await prod(code);
  await sb.rpc("adjust_product_stock", { p_branch_id: branchId, p_product_id: p.id, p_counted_quantity: qty, p_reason: "Prueba detalle de ticket desde la balanza (staging)" });
}
const before = { cajon: Number((await prod("9002")).stock), troz: Number((await prod("9005")).stock) };
console.log(`Stock antes: CAJON ${before.cajon} u. · TROZADITO ${before.troz} kg`);

const now = new Date();
const dd = String(now.getDate()).padStart(2, "0"), mm = String(now.getMonth() + 1).padStart(2, "0"), yy = String(now.getFullYear() % 100).padStart(2, "0");
const pad = (n: number, w: number) => String(n).padStart(w, "0");
const line = (ticket: number, time: string, plu: number, units: number, grams: number, amount: number) =>
  [pad(ticket, 9), `${dd}/${mm}/${yy}`, time, "01", pad(plu, 6), "01", pad(units, 4), pad(grams, 5), "00000", pad(amount * 100, 12)].join("^");
const REPORT = [line(3094, "12:50:02", 9005, 0, 235, 1222), line(3095, "12:55:34", 9002, 1, 0, 72000), line(3095, "12:55:34", 9005, 0, 215, 1118)].join("^") + "F";

const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
p.on("dialog", (d) => d.accept());
p.on("pageerror", (e) => console.log("[error página]", String(e).slice(0, 300)));
await p.addInitScript(`(() => {
  const w = window;
  localStorage.setItem("patagonia-systel-link", JSON.stringify({ address: 20, settings: { baudRate: 115200, stopBits: 1, parity: "none" } }));
  w.__scale = { report: ${JSON.stringify(REPORT)}, received: [], busy: 2 };
  const xor = (a) => a.reduce((x, y) => x ^ y, 0);
  const frame = (fn, data) => { const body = [20, fn, ...Array.from(data, (c) => c.charCodeAt(0))]; return new Uint8Array([...body, xor(body)]); };
  let push = null;
  const port = {
    readable: null, writable: null,
    getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6001 }),
    async open() {
      port.readable = new ReadableStream({ start: (c) => { push = (x) => c.enqueue(x); } });
      port.writable = new WritableStream({
        write(f) {
          const addr = f[0], fn = f[1];
          const data = String.fromCharCode(...f.subarray(2, f.length - 1));
          w.__scale.received.push(addr + ":" + fn + (data ? ":" + data : ""));
          if (addr !== 20 && addr !== 0) return;
          let reply = null;
          if (w.__scale.busy > 0) { w.__scale.busy--; reply = frame(fn, "E3"); }
          else if (fn === 23) reply = frame(23, "00D");
          else if (fn === 72) {
            const r = frame(72, w.__scale.report);
            // En dos tramos con una pausa, como hizo la lista 31 real.
            setTimeout(() => push && push(r.subarray(0, 100)), 15);
            setTimeout(() => push && push(r.subarray(100)), 300);
            return;
          } else reply = frame(fn, "E4");
          if (reply) setTimeout(() => push && push(reply), 15);
        }
      });
    },
    async close() { port.readable = null; port.writable = null; },
    async setSignals() {}
  };
  const serial = { requestPort: async () => port, getPorts: async () => [port], addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(navigator, "serial", { value: serial, configurable: true });
})();`);

await p.goto("http://localhost:5194/");
await p.getByLabel(/mail/i).fill(env.DEMO_OWNER_EMAIL);
await p.getByLabel(/contraseña|clave/i).fill(env.DEMO_OWNER_PASSWORD);
await p.getByRole("button", { name: /ingresar|entrar/i }).click();
await p.waitForTimeout(3500);
await p.getByRole("button", { name: /^Mostrador$/ }).first().click();
await p.waitForTimeout(2500);
const box = p.getByPlaceholder(/Escane|Buscar|código/i).first();
const lines = async () => (await p.locator(".pos-cart-row, .pos-ticket-line, tr").allInnerTexts()).filter((t) => /PRUEBA|Ticket de balanza/.test(t)).map((t) => t.replace(/\s+/g, " "));
const msg = async () => ((await p.locator("body").innerText()).split("\n").find((l) => /Ticket N\.º|No se cargó|Leyendo en la balanza/.test(l)) ?? "(sin mensaje)").trim();

await box.fill("2202000731184");
await box.press("Enter");
await p.waitForTimeout(400);
console.log("\nMientras lee:", await msg());
await p.waitForTimeout(9000);
console.log("Mensaje:", await msg());
console.log("Líneas del ticket:", JSON.stringify(await lines()));
console.log("Órdenes que recibió la balanza:", JSON.stringify(await p.evaluate(() => (window as any).__scale.received)));
await p.screenshot({ path: "tests/e2e/ui-ticket-detalle-balanza.png" });

// Mismo código otra vez en la misma venta: no lo vuelve a cargar.
await box.fill("2202000731184");
await box.press("Enter");
await p.waitForTimeout(3000);
console.log("\nSegundo escaneo del mismo TOTAL:", await msg());
console.log("Líneas:", JSON.stringify(await lines()));

await p.getByRole("button", { name: /Efectivo/ }).first().click();
await p.getByPlaceholder(/Recibiste/).first().fill("80000");
await p.getByRole("button", { name: /^(Cobrar|Confirmar cobro)/ }).first().click();
await p.waitForTimeout(800);
if (await p.getByRole("button", { name: /^Confirmar cobro/ }).count()) await p.getByRole("button", { name: /^Confirmar cobro/ }).first().click();
await p.waitForTimeout(3500);

// Venta nueva, mismo TOTAL: ese ticket ya se cobró.
await box.fill("2202000731184");
await box.press("Enter");
await p.waitForTimeout(3000);
console.log("\nOtra venta, mismo TOTAL ya cobrado:", await msg());
console.log("Líneas:", JSON.stringify(await lines()));
await b.close();

const after = { cajon: Number((await prod("9002")).stock), troz: Number((await prod("9005")).stock) };
const { data: sale } = await sb.from("pos_sales").select("id, total, branch_id").eq("branch_id", branchId).order("created_at", { ascending: false }).limit(1).single();
const { data: items } = await sb.from("pos_sale_items").select("product_id, quantity, unit_price, line_total, source").eq("sale_id", (sale as any).id);
const { data: movs } = await sb.from("inventory_movements").select("product_id, quantity, movement_type, branch_id").eq("reference_id", (sale as any).id);
console.log(`\nVenta ${(sale as any).id.slice(0, 8)}… total $${(sale as any).total} · sucursal correcta: ${(sale as any).branch_id === branchId}`);
console.log("Renglones:", JSON.stringify(items));
console.log("Movimientos de stock:", JSON.stringify(movs));
console.log(`CAJON: ${before.cajon} → ${after.cajon} u. (−${before.cajon - after.cajon})`);
console.log(`TROZADITO: ${before.troz} → ${after.troz} kg (−${(before.troz - after.troz).toFixed(3)})`);
