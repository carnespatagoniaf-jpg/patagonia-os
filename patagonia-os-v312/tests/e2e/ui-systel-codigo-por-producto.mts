// Pantalla REAL de Stock → Balanza contra STAGING, con una balanza Systel SIMULADA dentro del navegador
// (responde según el protocolo, arrancando de la configuración REAL de Los gringos con "ETi=N").
// Antes: agregar el id de la empresa Don Julio a SYSTEL_PILOT_COMPANIES (Inventory.tsx) y
// npm run dev:staging -w @patagonia/web -- --port 5193 --strictPort
// Corre desde la carpeta patagonia-os-v312: npx tsx tests/e2e/ui-systel-codigo-por-producto.mts
import fs from "node:fs";
import { chromium } from "playwright";

const env = Object.fromEntries(fs.readFileSync(new URL("../../.env.demo-staging", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const REAL_CONFIG = "Ton=2;Gris=0;Pap=0;APa=0;Vel=5;CPr=0;CAdm=01234;CCon=01234;Sinc=0;E_P=20PPPPCCCCCC;E_U=21PPPPCCCCCC;E_S=22BBIIIIIIII;CImp=2;Pub=LOS GRINGOS                    ;Enc1=NOMBRE DEL NEGOCIO;Enc2=Direccion - Telefono            ;PeP=3;SEt=S;ETi=N";

const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
p.on("dialog", (d) => d.accept());
p.on("console", (m) => { if (m.type() === "error" || m.text().includes("serial")) console.log("[consola]", m.type(), m.text().slice(0, 200)); });
p.on("pageerror", (e) => console.log("[error página]", String(e).slice(0, 300)));
await p.addInitScript(`(() => {
  const w = window;
  w.__scale = { config: ${JSON.stringify(REAL_CONFIG)}, received: [] };
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
          if (fn === 23) reply = frame(23, "00D");
          else if (fn === 2) reply = frame(2, "F2000C030000S0060P08000A060D0");
          else if (fn === 39) reply = frame(39, w.__scale.config);
          else if (fn === 7) {
            if (data[1] === "S" || data[1] === "N") w.__scale.config = w.__scale.config.replace(/;ETi=[^;]*/, ";ETi=" + data[1]);
            if (data[0] === "S" || data[0] === "N") w.__scale.config = w.__scale.config.replace(/;SEt=[^;]*/, ";SEt=" + data[0]);
            reply = frame(7, "ACK");
          }
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

await p.goto("http://localhost:5193/");
await p.getByLabel(/mail/i).fill(env.DEMO_OWNER_EMAIL);
await p.getByLabel(/contraseña|clave/i).fill(env.DEMO_OWNER_PASSWORD);
await p.getByRole("button", { name: /ingresar|entrar/i }).click();
await p.waitForTimeout(3500);
await p.getByRole("button", { name: /^Stock$/ }).first().click();
await p.waitForTimeout(2000);
await p.getByRole("button", { name: /^Balanza$/ }).first().click();
await p.waitForTimeout(500);
console.log("Configuración ANTES (ETi):", (await p.evaluate(() => (window as any).__scale.config)).match(/ETi=\w/)?.[0]);
await p.getByRole("button", { name: "Activar código por producto en la balanza" }).click();
await p.waitForTimeout(6000);
const text = await p.locator("body").innerText();
console.log("Pantalla:", (text.match(/✅[^\n]*|No quedó activado[^\n]*|No se pudo[^\n]*/) ?? ["(sin mensaje)"])[0]);
const s = await p.evaluate(() => (window as any).__scale);
console.log("Órdenes que recibió la balanza:", s.received.join("  "));
console.log("Configuración DESPUÉS (ETi):", s.config.match(/ETi=\w/)?.[0], "· resto igual:", s.config.replace("ETi=S", "ETi=N") === REAL_CONFIG);
await p.screenshot({ path: "tests/e2e/ui-systel-codigo.png" });
await b.close();
