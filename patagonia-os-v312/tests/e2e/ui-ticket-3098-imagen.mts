// Imágenes de cómo se vería en Mostrador el ticket REAL 3098 de Los gringos (14/10 10:34, foto del cliente):
// TROZADITO 0,145 kg $754 + GRINGO CAJON 1 u. $72.000 = TOTAL $72.754 (código 2202000727545, real).
// SIMULADO: los códigos de cada artículo (la balanza todavía los imprime en ceros) y los productos espejo PRUEBA
// 9002/9005 de STAGING (Don Julio). No cobra: solo saca las imágenes y cancela.
// Antes: npm run dev:staging -w @patagonia/web -- --port 5194 --strictPort
import fs from "node:fs";
import { chromium } from "playwright";

const env = Object.fromEntries(fs.readFileSync(new URL("../../.env.demo-staging", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const ean = (first12: string) => {
  const s = first12.split("").map(Number).reduce((a, d, i) => a + d * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (s % 10)) % 10);
};
const TEMPLATES = {
  weighed: "20PPPPCCCCCC", unit: "21PPPPCCCCCC", sums: "22AAIIIIIIII", at: Date.now(),
  perPlu: {
    "9002": { type: 1, config: "21PPPPCCCCCC", p1: 72000, p2: 68000, name: "GRINGO CAJON DE", saleType: "U" },
    "9005": { type: 1, config: "20PPPPCCCCCC", p1: 5200, p2: 4700, name: "TROZADITOx1x2", saleType: "P" }
  }
};
const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
p.on("dialog", (d) => d.accept());
await p.addInitScript(`localStorage.setItem("patagonia-systel-label-templates", ${JSON.stringify(JSON.stringify(TEMPLATES))});`);
await p.goto("http://localhost:5194/");
await p.getByLabel(/mail/i).fill(env.DEMO_OWNER_EMAIL);
await p.getByLabel(/contraseña|clave/i).fill(env.DEMO_OWNER_PASSWORD);
await p.getByRole("button", { name: /ingresar|entrar/i }).click();
await p.waitForTimeout(3500);
await p.getByRole("button", { name: /^Mostrador$/ }).first().click();
await p.waitForTimeout(2500);
const box = p.getByPlaceholder(/Escane|Buscar|código/i).first();
for (const code of [ean("209005000145"), ean("219002000001")]) {
  await box.fill(code);
  await box.press("Enter");
  await p.waitForTimeout(900);
}
await p.screenshot({ path: "tests/e2e/mostrador-ticket-3098-1-esperando-total.png" });
await box.fill("2202000727545");
await box.press("Enter");
await p.waitForTimeout(1500);
await p.screenshot({ path: "tests/e2e/mostrador-ticket-3098-2-confirmado.png" });
console.log(((await p.locator("body").innerText()).split("\n").find((l) => /Importes confirmados|No se confirmaron/.test(l)) ?? "(sin mensaje)").trim());
await p.getByRole("button", { name: /Cancelar ticket/ }).first().click();
await b.close();
