// Pantalla REAL de Stock → Balanza contra STAGING (Don Julio) + Cuora Max SIMULADA en el navegador.
// REAL (de la balanza de Los gringos): firma "F2000C030000S0060P08000A060D0", configuración del 13/10 20:42
// (E_P=20PPPPCCCCII…), y E7 al pedido de ventas del documento (131026131026).
// SIMULADO: que con "hoy a mañana" sí devuelva ventas (es UNA de las hipótesis), los registros de producto (62)
// y las ventas (ticket real de 2 artículos con los productos espejo PRUEBA 9002 / 9005).
// Antes: npm run dev:staging -w @patagonia/web -- --port 5194 --strictPort
// Corre desde patagonia-os-v312: npx tsx tests/e2e/ui-systel-diagnostico.mts
import fs from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { fakeReadRecord } from "../../apps/web/src/features/inventory/systel/systel-fake";

const env = Object.fromEntries(fs.readFileSync(new URL("../../.env.demo-staging", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const sb = createClient(env.DEMO_SUPABASE_URL, env.DEMO_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await sb.auth.signInWithPassword({ email: env.DEMO_OWNER_EMAIL, password: env.DEMO_OWNER_PASSWORD });
const { data: prods } = await sb.from("products_with_stock").select("code, name, unit, price_retail").eq("branch_id", env.DEMO_BRANCH_ID);
const PLUS: Record<string, string> = {};
for (const p of (prods ?? []) as any[]) {
  if (!/^\d{1,4}$/.test(p.code)) continue;
  PLUS[p.code.padStart(4, "0")] = fakeReadRecord("max60", { number: Number(p.code), name: String(p.name).slice(0, 18), price: Math.round(Number(p.price_retail)), code: Number(p.code), type: p.unit === "kg" ? "P" : "U" });
}
const CONFIG = "Ton=2;Gris=0;Pap=0;APa=0;Vel=5;CPr=0;CAdm=01234;CCon=01234;Sinc=0;E_P=20PPPPCCCCII;E_U=21PPPPCCCCII;E_S=22AAIIIIIIII;CImp=2;Pub=LOS GRINGOS                    ;Enc1=NOMBRE DEL NEGOCIO;Enc2=Direccion - Telefono            ;PeP=3;SEt=S;ETi=S";
const now = new Date();
const p2 = (n: number) => String(n).padStart(2, "0");
const today = `${p2(now.getDate())}/${p2(now.getMonth() + 1)}/${p2(now.getFullYear() % 100)}`;
const todayReq = `${p2(now.getDate())}${p2(now.getMonth() + 1)}${p2(now.getFullYear() % 100)}`;
const line = (t: number, time: string, plu: number, units: number, grams: number, amount: number) => [String(t).padStart(9, "0"), today, time, "01", String(plu).padStart(6, "0"), "01", String(units).padStart(4, "0"), String(grams).padStart(5, "0"), "00000", String(amount * 100).padStart(12, "0")].join("^");
const REPORT = [line(3095, "12:55:34", 9002, 1, 0, 72000), line(3095, "12:55:34", 9005, 0, 215, 1118)].join("^") + "F";
const CLOCK = `${p2(now.getHours())}:${p2(now.getMinutes())}:00 ${today}`;

const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1400, height: 1100 } });
p.on("dialog", (d) => d.accept());
p.on("pageerror", (e) => console.log("[error página]", String(e).slice(0, 300)));
await p.addInitScript(`(() => {
  const w = window;
  localStorage.setItem("patagonia-systel-link", JSON.stringify({ address: 20, settings: { baudRate: 115200, stopBits: 1, parity: "none" } }));
  w.__scale = { received: [], plus: ${JSON.stringify(PLUS)} };
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
          let reply;
          if (fn === 23) reply = frame(23, "00D");
          else if (fn === 2) reply = frame(2, "F2000C030000S0060P08000A060D0");
          else if (fn === 28) reply = frame(28, ${JSON.stringify(CLOCK)});
          else if (fn === 39) reply = frame(39, ${JSON.stringify(CONFIG)});
          else if (fn === 62) reply = w.__scale.plus[data] ? frame(62, w.__scale.plus[data]) : frame(62, "E7");
          else if (fn === 72) reply = data === ${JSON.stringify(todayReq + todayReq)} ? frame(72, "E7") : data.startsWith(${JSON.stringify(todayReq)}) ? frame(72, ${JSON.stringify(REPORT)}) : frame(72, "E7");
          else reply = frame(fn, "E4");
          setTimeout(() => push && push(reply), 15);
        }
      });
    },
    async close() { port.readable = null; port.writable = null; },
    async setSignals() {}
  };
  Object.defineProperty(navigator, "serial", { value: { requestPort: async () => port, getPorts: async () => [port], addEventListener() {}, removeEventListener() {} }, configurable: true });
})();`);
await p.goto("http://localhost:5194/");
await p.getByLabel(/mail/i).fill(env.DEMO_OWNER_EMAIL);
await p.getByLabel(/contraseña|clave/i).fill(env.DEMO_OWNER_PASSWORD);
await p.getByRole("button", { name: /ingresar|entrar/i }).click();
await p.waitForTimeout(3500);
await p.getByRole("button", { name: /^Stock$/ }).first().click();
await p.waitForTimeout(2500);
await p.getByRole("button", { name: /^Balanza$/ }).first().click();
await p.waitForTimeout(500);
await p.getByRole("button", { name: /Diagnóstico completo \(solo lectura\)/ }).click();
await p.waitForTimeout(12000);
const panelText = await p.getByText("Solo lectura: no se cambió nada en la balanza ni en Patagonia.").locator("..").innerText();
console.log(panelText);
await p.screenshot({ path: "tests/e2e/ui-systel-diagnostico.png", fullPage: false });
const received: string[] = await p.evaluate(() => (window as any).__scale.received);
const fns = [...new Set(received.map((r) => Number(r.split(":")[1])))].sort((a, b) => a - b);
console.log("\nFunciones que recibió la balanza:", fns.join(", "), "· pedidos 72:", received.filter((r) => r.split(":")[1] === "72").map((r) => r.split(":")[2]).join(", "));
console.log("62 recibidos:", received.filter((r) => r.split(":")[1] === "62" || r.split(":")[1] === "3").slice(0, 6).join(" "), "· registros cargados:", Object.keys(await p.evaluate(() => (window as any).__scale.plus)).slice(0, 8).join(","));
await b.close();
