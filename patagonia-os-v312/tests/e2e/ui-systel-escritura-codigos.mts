// Pantalla REAL de Stock → Balanza (STAGING, empresa aislada "PRUEBA Balanzas") con una Cuora Max SIMULADA en el
// navegador que guarda lo que se le escribe. Prueba la herramienta de escritura del código de cada producto:
// respaldo → 1 (número libre) → 2 (producto real sin ventas; antes uno CON ventas, que tiene que rechazar) →
// 3 (todos) → restaurar. Dos balanzas simuladas: una acepta el tipo de código como byte y otra como dígito.
// SIMULADO: la balanza. REAL: los registros de producto de Los gringos (PLU 2 y 13) como molde, sus nombres,
// formas de venta y precios, la firma y la configuración.
// Antes (desde apps/web): VITE_SYSTEL_BARCODE_WRITES=1 npx vite --mode staging --port 5196 --strictPort
import fs from "node:fs";
import { chromium } from "playwright";
import { REAL_PLU_13_PECHUGA_SH, REAL_PLU_2_GRINGO_CAJON } from "../../apps/web/src/features/sale/systel-real-plu-records";
import { realCatalog } from "../../apps/web/src/features/scales/sale/los-gringos-fixture";
import { pluEanSetting } from "../../apps/web/src/features/inventory/systel/systel-plu";
import { onlyBarcodeChanged } from "../../apps/web/src/features/inventory/systel/systel-product-barcode";
import { buildCode, parseTemplate } from "../../apps/web/src/features/scales/sale/label-template";

const readEnv = (p: string) => Object.fromEntries(fs.readFileSync(new URL(p, import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const env = readEnv("../../.env.balanzas-staging");
let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "OK  " : "FALLA"} ${msg}`);
  if (!cond) failures++;
};

// Registros de la balanza simulada: uno por producto de Patagonia, con el molde REAL de su forma de venta.
const P_TEMPLATE = REAL_PLU_13_PECHUGA_SH.replace("\u000120PPPPCCCCCC", "\u0001000000000000");
const PLUS: Record<string, string> = {};
for (const it of realCatalog()) {
  const tpl = it.saleType === "U" ? REAL_PLU_2_GRINGO_CAJON : P_TEMPLATE;
  const num = String(it.code).padStart(4, "0");
  PLUS[num] = num + tpl[4] + it.name.slice(0, 18).padEnd(18, " ") + String(it.prices[0]).padStart(6, "0") + String(it.prices[1] ?? 0).padStart(6, "0") + String(it.code).padStart(5, "0") + tpl.slice(40);
}
const ORIGINAL = { ...PLUS };
const now = new Date();
const p2 = (n: number) => String(n).padStart(2, "0");
const today = `${p2(now.getDate())}/${p2(now.getMonth() + 1)}/${p2(now.getFullYear() % 100)}`;
// Ventas de la balanza: el producto 2 se vendió hoy (no se puede usar en la prueba 2).
const REPORT = `000003095^${today}^12:55:34^02^0002^01^0001^00000^00000^000007200000;000003095^${today}^12:55:34^02^0005^01^0000^00215^00000^000000111800F`;
const CONFIG = "Ton=2;Gris=0;Pap=0;APa=0;Vel=5;CPr=0;CAdm=01234;CCon=01234;Sinc=0;E_P=20PPPPCCCCII;E_U=21PPPPCCCCII;E_S=22AAIIIIIIII;CImp=2;SEt=S;ETi=S";

async function run(typeByteAccepted: "binario" | "ascii") {
  console.log(`\n=== Balanza simulada que acepta el tipo de código como ${typeByteAccepted === "binario" ? "BYTE" : "DÍGITO"} ===`);
  const b = await chromium.launch({ channel: "chrome" });
  const p = await b.newPage({ viewport: { width: 1400, height: 1200 } });
  const prompts: string[] = [];
  p.on("dialog", (d) => {
    prompts.push(d.message().split("\n")[0]);
    void (d.type() === "prompt" ? d.accept("AUTORIZO") : d.accept());
  });
  p.on("pageerror", (e) => console.log("[error de página]", String(e).slice(0, 200)));
  await p.addInitScript(`(() => {
    const w = window;
    localStorage.removeItem("patagonia-systel-barcode-writes");
    localStorage.removeItem("patagonia-systel-product-backup");
    // Lo que deja el "Diagnóstico completo" en esta computadora: los formatos de código de la balanza (reales).
    localStorage.setItem("patagonia-systel-label-templates", JSON.stringify({ weighed: "20PPPPCCCCII", unit: "21PPPPCCCCII", sums: "22AAIIIIIIII", at: Date.now(), perPlu: {} }));
    localStorage.setItem("patagonia-systel-link", JSON.stringify({ address: 20, settings: { baudRate: 115200, stopBits: 1, parity: "none" } }));
    w.__scale = { received: [], plus: ${JSON.stringify(PLUS)}, mode: ${JSON.stringify(typeByteAccepted)} };
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
            // Verificación (XOR) de lo que llega: si no cierra, E1 (como la balanza).
            const okCheck = xor(Array.from(f.subarray(0, f.length - 1))) === f[f.length - 1];
            const data = String.fromCharCode(...f.subarray(2, f.length - 1));
            w.__scale.received.push({ fn, data });
            if (addr !== 20 && addr !== 0) return;
            let reply;
            if (!okCheck) reply = frame(fn, "E1");
            else if (fn === 23) reply = frame(23, "00T");
            else if (fn === 2) reply = frame(2, "F2000C030000S0060P08000A060D0");
            else if (fn === 39) reply = frame(39, ${JSON.stringify(CONFIG)});
            else if (fn === 62) reply = w.__scale.plus[data] ? frame(62, w.__scale.plus[data]) : frame(62, "E7");
            else if (fn === 72) reply = frame(72, ${JSON.stringify(REPORT)});
            else if (fn === 61) {
              const rec = data.slice(0, 4) + "1" + data.slice(4);
              const end = rec[rec.length - 1] === "N" ? rec.length - 1 : rec.length - 101;
              const t = rec.charCodeAt(end - 13);
              if ((w.__scale.mode === "binario" && t > 3) || (w.__scale.mode === "ascii" && t <= 3)) reply = frame(61, "E8");
              else {
                w.__scale.plus[data.slice(0, 4)] = t > 3 ? rec.slice(0, end - 13) + String.fromCharCode(t - 48) + rec.slice(end - 12) : rec;
                reply = frame(61, "ACK");
              }
            } else reply = frame(fn, "E4");
            setTimeout(() => push && push(reply), 5);
          }
        });
      },
      async close() { port.readable = null; port.writable = null; },
      async setSignals() {}
    };
    Object.defineProperty(navigator, "serial", { value: { requestPort: async () => port, getPorts: async () => [port], addEventListener() {}, removeEventListener() {} }, configurable: true });
  })();`);
  await p.goto("http://localhost:5196/");
  await p.getByLabel(/mail/i).fill(env.BAL_EMAIL);
  await p.getByLabel(/contraseña|clave/i).fill(env.BAL_PASSWORD);
  await p.getByRole("button", { name: /ingresar|entrar/i }).click();
  await p.waitForTimeout(3500);
  await p.getByRole("button", { name: "Stock", exact: true }).click();
  await p.waitForTimeout(2500);
  await p.getByRole("button", { name: /^Balanza$/ }).first().click();
  await p.waitForTimeout(800);
  const line = async (re: RegExp) => ((await p.locator("body").innerText()).split("\n").find((l) => re.test(l)) ?? "(sin mensaje)").trim();
  const waitFor = async (re: RegExp, ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (re.test(await p.locator("body").innerText())) return true;
      await p.waitForTimeout(500);
    }
    return false;
  };
  const scale = async () => p.evaluate(() => (window as any).__scale) as Promise<{ received: { fn: number; data: string }[]; plus: Record<string, string> }>;

  check(await p.getByRole("button", { name: /1\. Probar en números libres/ }).isDisabled(), "sin respaldo del día, la prueba 1 está deshabilitada");
  await p.getByRole("button", { name: /Respaldar los productos/ }).click();
  check(await waitFor(/Respaldo completo y verificado/), `respaldo: ${await line(/Respaldo (completo|INCOMPLETO)/)}`);
  check(await p.getByRole("button", { name: /2\. Probar en este producto/ }).isDisabled() && await p.getByRole("button", { name: /3\. Todos los productos/ }).isDisabled(), "la 2 y la 3 están deshabilitadas antes de la 1");

  await p.getByRole("button", { name: /1\. Probar en números libres/ }).click();
  check(/Marcá primero/.test(await line(/Marcá primero/)), "sin marcar la autorización no escribe");
  await p.getByLabel(/autorizaron esta prueba/).check();
  const before1 = (await scale()).received.length;
  await p.getByRole("button", { name: /1\. Probar en números libres/ }).click();
  check(await waitFor(/Prueba 1 \(número libre\): (CONFIRMADO|FRENADO)/), `prueba 1: ${await line(/Prueba 1 \(número libre\)/)}`);
  let s = await scale();
  const writes1 = s.received.slice(before1).filter((x) => x.fn === 61);
  check(/CONFIRMADO/.test(await line(/Prueba 1 \(número libre\)/)) && writes1.every((x) => x.data.startsWith("7999") || x.data.startsWith("7998")), `la prueba 1 escribió solo en los N.º 7999 y 7998 (${writes1.length} escritura(s): ${typeByteAccepted === "ascii" ? "byte rechazado, dígito aceptado, y el de unidad" : "byte aceptado, y el de unidad"})`);
  check(pluEanSetting(s.plus["7998"] ?? "").config === "21PPPPCCCCCC" && s.plus["7998"]?.slice(5, 23) === "PRUEBA PATAGONIA  ", `producto de prueba por unidad (7998): código ${pluEanSetting(s.plus["7998"] ?? "").config}`);
  check(!!s.plus["7999"] && s.plus["7999"].slice(5, 23) === "PRUEBA PATAGONIA  " && s.plus["7999"].slice(23, 35) === "000001000000", `producto de prueba por peso (7999): "${s.plus["7999"]?.slice(5, 23)}", precios ${s.plus["7999"]?.slice(23, 35)} ($1)`);

  // Lo que imprimiría la balanza al vender los productos de prueba: el cliente lo escanea en "Probar un código impreso".
  const probe = p.getByPlaceholder("Código de barras");
  for (const [code, re, what] of [
    [buildCode(parseTemplate("20PPPPCCCCCC")!, { P: 7999, C: 1530 })!, /PRUEBA PATAGONIA.*N\.º 7999.*1,530 kg/, "pesado 1,530 kg"],
    [buildCode(parseTemplate("21PPPPCCCCCC")!, { P: 7998, C: 2 })!, /PRUEBA PATAGONIA.*N\.º 7998.*2 unidad/, "2 unidades"],
    [buildCode(parseTemplate("22AAIIIIIIII")!, { A: 2, I: 4 })!, /TOTAL del ticket: \$4, 2 artículo/, "TOTAL $4"]
  ] as const) {
    await probe.fill(code);
    await probe.press("Enter");
    await p.waitForTimeout(300);
    const t = await line(/TOTAL del ticket|unidad\(es\)|kg →|No se puede usar|No es un código/);
    check(re.test(t), `probar el código impreso (${what}): ${t}`);
  }

  // 1b: reescribir el producto de prueba (para comparar su total en la balanza antes y después).
  const n61 = (await scale()).received.filter((x) => x.fn === 61).length;
  await p.getByRole("button", { name: /1b\. Reescribir el producto de prueba/ }).click();
  check(await waitFor(/Prueba 1b \(reescritura del N\.º 7999\): CONFIRMADO/), `1b: ${await line(/Prueba 1b/)}`);
  s = await scale();
  check(s.received.filter((x) => x.fn === 61).slice(n61 - s.received.filter((x) => x.fn === 61).length).every((x) => x.data.startsWith("7999")), "la 1b escribió solo en el producto de prueba 7999");
  check(Object.keys(ORIGINAL).every((k) => s.plus[k] === ORIGINAL[k]), "después de la prueba 1, los 104 productos del cliente están byte a byte iguales");

  await p.getByLabel(/Producto N\.º/).fill("2");
  await p.getByRole("button", { name: /2\. Probar en este producto/ }).click();
  check(await waitFor(/Prueba 2 \(producto 2\): FRENADO/), `prueba 2 con un producto CON ventas: ${await line(/Prueba 2 \(producto 2\)/)} · ${await line(/tiene ventas/)}`);
  s = await scale();
  check(s.plus["0002"] === ORIGINAL["0002"], "el producto 2 (con ventas) no se tocó");
  await p.getByLabel(/Producto N\.º/).fill("6");
  await p.getByRole("button", { name: /2\. Probar en este producto/ }).click();
  check(await waitFor(/Prueba 2 \(producto 6\): CONFIRMADO/), `prueba 2 con el producto 6 (sin ventas): ${await line(/Prueba 2 \(producto 6\)/)}`);
  s = await scale();
  check(pluEanSetting(s.plus["0006"]).config === "20PPPPCCCCCC" && onlyBarcodeChanged(ORIGINAL["0006"], s.plus["0006"], "max60"), "producto 6: solo cambió el código de barras (20PPPPCCCCCC); precios y nombre iguales");

  await p.getByRole("button", { name: /3\. Todos los productos/ }).click();
  check(await waitFor(/Listo: \d+ productos confirmados|FRENADO en el producto/, 120000), `todos: ${await line(/Listo: |FRENADO en el producto/)}`);
  s = await scale();
  const changedOk = Object.keys(ORIGINAL).every((k) => onlyBarcodeChanged(ORIGINAL[k], s.plus[k], "max60"));
  const targetOk = Object.keys(ORIGINAL).every((k) => ["20PPPPCCCCCC", "21PPPPCCCCCC"].includes(pluEanSetting(s.plus[k]).config ?? ""));
  check(changedOk && targetOk, `los 104 productos: código propio ${targetOk ? "configurado" : "INCOMPLETO"} y ${changedOk ? "ningún otro dato cambió" : "OTRO DATO CAMBIÓ"}`);
  const fns = [...new Set(s.received.map((x) => x.fn))].sort((a, c) => a - c);
  check(fns.every((f) => [2, 23, 39, 61, 62, 72].includes(f)), `funciones que recibió la balanza: ${fns.join(", ")} (ninguna de precio, borrado, cierre ni configuración)`);

  await p.getByRole("button", { name: /Restaurar desde el respaldo/ }).click();
  check(await waitFor(/Restauración: /, 120000), `restaurar: ${await line(/Restauración: /)}`);
  s = await scale();
  const restoredOk = Object.keys(ORIGINAL).every((k) => s.plus[k].slice(5) === ORIGINAL[k].slice(5));
  check(restoredOk, "restaurados: los 104 productos iguales al original salvo la marca \"gestionado por PC\" (no se puede volver a \"balanza\")");
  check(!!s.plus["7999"] && !!s.plus["7998"], "los productos de prueba 7999 y 7998 siguen en la balanza (no se usa ninguna función de borrado; el cliente los borra a mano o se reusan)");
  await p.screenshot({ path: "../../tests/e2e/systel-escritura-codigos.png", fullPage: true });
  await b.close();
}

await run("binario");
await run("ascii");
console.log(failures === 0 ? "\nTODO OK" : `\n${failures} FALLAS`);
