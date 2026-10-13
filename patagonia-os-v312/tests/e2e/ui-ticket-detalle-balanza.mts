// Pantalla REAL del Mostrador contra STAGING (Don Julio) + balanza Systel SIMULADA dentro del navegador
// (Web Serial falso que contesta según el protocolo: 23 ping y 72 reporte de ventas).
// REAL: el código del TOTAL escaneado (2202000731184, foto del ticket de Los gringos 13/10, op. 20-3095)
//       y los artículos/importes de ese ticket (cajón 1 un $72.000 + trozadito 0,215 kg $1.118).
// SIMULADO: las respuestas 39/62/72 (armada con el formato del documento; nunca se leyó una real),
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

// Corridas anteriores: se anulan sus ventas (si no, esos tickets ya figuran cobrados, como debe ser).
const { data: prev } = await sb.from("pos_sale_items").select("sale_id, pos_sales!inner(voided_at, branch_id)").like("scale_ticket", "systel:20:%").is("pos_sales.voided_at", null).eq("pos_sales.branch_id", branchId);
for (const id of new Set((prev ?? []).map((r: any) => r.sale_id))) await sb.rpc("void_pos_sale", { p_sale_id: id });

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
// Dos tickets DISTINTOS con el mismo total y la misma cantidad de artículos (3095 = el real; 3101 = otro igual).
const REPORT = [line(3094, "12:50:02", 9005, 0, 235, 1222), line(3095, "12:55:34", 9002, 1, 0, 72000), line(3095, "12:55:34", 9005, 0, 215, 1118), line(3101, "13:20:10", 9002, 1, 0, 72000), line(3101, "13:20:11", 9005, 0, 215, 1118)].join("^") + "F";
// Registros 62 (formato max60) de los productos de la balanza: su CÓDIGO y su tipo de venta (U unidad, P peso).
const PLUS: Record<string, string> = {"9002":"90020GRINGO CAJON DE   07200000000009002010005U00000000N                              00000000000000000000000000000000000100000000000000000123120PPPPIIIIIIN","9005":"90050TROZADITOx1x2     00520000000009005010005P00000000N                              00000000000000000000000000000000000100000000000000000123120PPPPIIIIIIN"};
const CONFIG = "Ton=2;Gris=0;Pap=0;APa=0;Vel=5;CPr=0;CAdm=01234;CCon=01234;Sinc=0;E_P=20PPPPCCCCCC;E_U=21PPPPCCCCCC;E_S=22AAIIIIIIII;CImp=2;Pub=LOS GRINGOS;PeP=3;SEt=S;ETi=S";

const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
p.on("dialog", (d) => d.accept());
p.on("pageerror", (e) => console.log("[error página]", String(e).slice(0, 300)));
await p.addInitScript(`(() => {
  const w = window;
  localStorage.setItem("patagonia-systel-link", JSON.stringify({ address: 20, settings: { baudRate: 115200, stopBits: 1, parity: "none" } }));
  w.__scale = { report: ${JSON.stringify(REPORT)}, plus: ${JSON.stringify(PLUS)}, config: ${JSON.stringify(CONFIG)}, received: [], busy: 2 };
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
          else if (fn === 39) reply = frame(39, w.__scale.config);
          else if (fn === 62) reply = w.__scale.plus[data] ? frame(62, w.__scale.plus[data]) : frame(62, "E7");
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
const lines = async () => (await p.locator(".pos-cart-row").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
const msg = async () => ((await p.locator("body").innerText()).split("\n").find((l) => /Ticket N\.º|No se cargó|Leyendo en la balanza|Hoy hay \d+ tickets|ya está cargado/.test(l)) ?? "(sin mensaje)").trim();
const scanTotal = async (label: string) => {
  await box.fill("2202000731184");
  await box.press("Enter");
  await p.waitForTimeout(9000);
  console.log(`\n[${label}] mensaje: ${await msg()}`);
};
const charge = async () => {
  await p.getByRole("button", { name: /Efectivo/ }).first().click();
  await p.getByPlaceholder(/Recibiste/).first().fill("80000");
  await p.getByRole("button", { name: /^(Cobrar|Confirmar cobro)/ }).first().click();
  await p.waitForTimeout(800);
  if (await p.getByRole("button", { name: /^Confirmar cobro/ }).count()) await p.getByRole("button", { name: /^Confirmar cobro/ }).first().click();
  await p.waitForTimeout(3500);
};

// 1. Dos tickets con el mismo total: NO elige solo, muestra los dos.
await scanTotal("TOTAL real escaneado, hay 2 tickets iguales en la balanza");
const choices = await p.locator(".pos-manual-card button").allInnerTexts();
console.log("Opciones:", JSON.stringify(choices.map((t) => t.replace(/\s+/g, " "))));
console.log("Líneas antes de elegir:", JSON.stringify(await lines()));
await p.screenshot({ path: "tests/e2e/ui-ticket-detalle-balanza-elegir.png" });
// La persona elige el que tiene en la mano (op. 3095, 12:55:34).
await p.getByRole("button", { name: /Operación N\.º 3095/ }).click();
await p.waitForTimeout(500);
console.log("Elegido 3095 →", await msg());
console.log("Líneas:", JSON.stringify(await lines()));
await p.screenshot({ path: "tests/e2e/ui-ticket-detalle-balanza.png" });
await charge();
const { data: sale1 } = await sb.from("pos_sales").select("id, total, branch_id").eq("branch_id", branchId).order("created_at", { ascending: false }).limit(1).single();

// 2. Mismo TOTAL otra vez: el 3095 ya está cobrado (por identidad); queda el 3101 y lo carga sin preguntar.
await scanTotal("mismo TOTAL, otra venta");
console.log("Líneas:", JSON.stringify(await lines()));
await charge();
const { data: sale2 } = await sb.from("pos_sales").select("id, total, branch_id").eq("branch_id", branchId).order("created_at", { ascending: false }).limit(1).single();

// 3. Tercera vez: los dos están cobrados.
await scanTotal("mismo TOTAL, tercera vez");
console.log("Líneas:", JSON.stringify(await lines()));

// 4. Se anula la venta del 3095: ese ticket se puede volver a cargar (el 3101 sigue cobrado).
const { error: voidErr } = await sb.rpc("void_pos_sale", { p_sale_id: (sale1 as any).id });
console.log("\nAnulada la venta del 3095:", voidErr ? voidErr.message : "ok");
await scanTotal("mismo TOTAL después de anular la venta del 3095");
console.log("Líneas:", JSON.stringify(await lines()));
await p.getByRole("button", { name: /Cancelar ticket/ }).first().click();
await p.waitForTimeout(500);
console.log("\nÓrdenes que recibió la balanza:", JSON.stringify(await p.evaluate(() => (window as any).__scale.received)));
await b.close();

for (const s of [sale1, sale2] as any[]) {
  const { data: items } = await sb.from("pos_sale_items").select("product_id, quantity, unit_price, line_total, source, scale_ticket").eq("sale_id", s.id);
  const { data: movs } = await sb.from("inventory_movements").select("product_id, quantity, movement_type, branch_id").eq("reference_id", s.id);
  console.log(`\nVenta ${s.id.slice(0, 8)}… total $${s.total} · sucursal correcta: ${s.branch_id === branchId}`);
  console.log("Renglones:", JSON.stringify(items));
  console.log("Movimientos de stock:", JSON.stringify(movs));
}

const after = { cajon: Number((await prod("9002")).stock), troz: Number((await prod("9005")).stock) };
console.log(`CAJON: ${before.cajon} → ${after.cajon} u. (−${before.cajon - after.cajon})`);
console.log(`TROZADITO: ${before.troz} → ${after.troz} kg (−${(before.troz - after.troz).toFixed(3)})`);
console.log(`Precio del TROZADITO en Patagonia durante la prueba: ${(await prod("9005")).price_retail} (la balanza cobró $5.200/kg)`);
