// Pantalla REAL (Stock y Mostrador) contra STAGING, empresa aislada "PRUEBA Balanzas (staging)", sin balanza conectada.
// Simula lo que imprimiría la Systel configurada con 20PPPPCCCCCC / 21PPPPCCCCCC por producto.
// REAL: tickets 3095 (cajón + trozadito, $73.118) y 3087 (cajón a lista 2), formatos y precios de la balanza de Los gringos.
// Antes: (desde apps/web del worktree) npx vite --mode staging --port 5195 --strictPort
// Corre desde apps/web: npx tsx ../../tests/e2e/ui-balanza-articulos-total.mts
import fs from "node:fs";
import { chromium, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { buildCode, parseTemplate, withCheckDigit } from "../../apps/web/src/features/scales/sale/label-template";

const readEnv = (p: string) => Object.fromEntries(fs.readFileSync(new URL(p, import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const env = readEnv("../../.env.balanzas-staging");
const anon = readEnv("../../.env.demo-staging").DEMO_SUPABASE_ANON_KEY;
const URL_APP = "http://localhost:5195/";
const sb = createClient(env.BAL_SUPABASE_URL, anon, { auth: { persistSession: false } });
await sb.auth.signInWithPassword({ email: env.BAL_EMAIL, password: env.BAL_PASSWORD });
const branch = env.BAL_BRANCH_ID;
let failures = 0;
// Gramos distintos en cada corrida: los papeles de las corridas anteriores (mismo día) ya están cobrados.
const salt = (1 + Math.floor(Math.random() * 400)) / 1000;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "OK  " : "FALLA"} ${msg}`);
  if (!cond) failures++;
};

const item = (code: number, qty: number) => buildCode(parseTemplate(code === 2 || code === 12 ? "21PPPPCCCCCC" : "20PPPPCCCCCC")!, { P: code, C: code === 2 || code === 12 ? qty : Math.round(qty * 1000) })!;
const total = (articles: number, amount: number) => buildCode(parseTemplate("22AAIIIIIIII")!, { A: articles, I: amount })!;
const productId = async (code: string) => (await sb.from("products_with_stock").select("id").eq("branch_id", branch).eq("code", code).single()).data!.id as string;
const stockOf = async (code: string) => Number((await sb.from("products_with_stock").select("stock").eq("branch_id", branch).eq("code", code).single()).data!.stock);
const codeById = new Map<string, string>();
const lastSale = async () => {
  const { data: s } = await sb.from("pos_sales").select("id, total, voided_at").eq("branch_id", branch).order("created_at", { ascending: false }).limit(1).single();
  const { data: rows, error: e } = await sb.from("pos_sale_items").select("quantity, line_total, description, product_id").eq("sale_id", s!.id);
  if (e) throw e;
  for (const r of rows ?? []) if (r.product_id && !codeById.has(r.product_id)) codeById.set(r.product_id, (await sb.from("products_with_stock").select("code").eq("id", r.product_id).limit(1).single()).data!.code);
  const items = (rows ?? []).map((r: any) => ({ ...r, products: r.product_id ? { code: codeById.get(r.product_id) } : null }));
  const { count } = await sb.from("pos_scale_paper_claims").select("id", { count: "exact", head: true }).eq("sale_id", s!.id);
  return { id: s!.id as string, total: Number(s!.total), claims: count ?? 0, items: (items ?? []).map((i: any) => `${i.products?.code ?? "libre"} ${Number(i.quantity)} $${Number(i.line_total)}`) };
};

// Preparación: 2 productos sin decidir, para probar la pantalla de vínculos.
await sb.rpc("set_scale_links", { p_branch_id: branch, p_scale_key: "systel-20", p_links: [{ code: 2, kind: "none" }, { code: 98, kind: "none" }] });
// La pantalla usa la balanza "systel" (Guardar productos leídos); la prueba de 945 guardó "systel-20": se usa esa misma.
const prof = await sb.from("scale_profiles").select("scale_key").eq("branch_id", branch);
check((prof.data ?? []).length === 1, `una sola balanza de venta configurada en la sucursal (${(prof.data ?? []).map((p: any) => p.scale_key).join(", ")})`);

const browser = await chromium.launch(process.env.PW_BUNDLED ? {} : { channel: "chrome" });
async function openPage(): Promise<{ page: Page; dialogs: string[]; answers: Array<string | boolean> }> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const dialogs: string[] = [];
  const answers: Array<string | boolean> = [];
  page.on("dialog", (d) => {
    dialogs.push(`${d.type()}: ${d.message().split("\n")[0]}`);
    const a = answers.shift();
    if (d.type() === "prompt") void d.accept(typeof a === "string" ? a : "");
    else void (a === false ? d.dismiss() : d.accept());
  });
  page.on("pageerror", (e) => console.log("[error de página]", String(e).slice(0, 200)));
  await page.goto(URL_APP);
  await page.getByLabel(/mail/i).fill(env.BAL_EMAIL);
  await page.getByLabel(/contraseña|clave/i).fill(env.BAL_PASSWORD);
  await page.getByRole("button", { name: /ingresar|entrar/i }).click();
  await page.waitForTimeout(3500);
  return { page, dialogs, answers };
}
const bodyLine = async (page: Page, re: RegExp) => ((await page.locator("body").innerText()).split("\n").find((l) => re.test(l)) ?? "(sin mensaje)").trim();

// 1. Stock → Balanza: vínculos.
const { page, dialogs, answers } = await openPage();
await page.getByRole("button", { name: "Stock", exact: true }).click();
await page.waitForTimeout(2000);
await page.getByRole("button", { name: /^Balanza$/ }).click();
await page.waitForTimeout(2500);
check(/104 productos de la balanza/.test(await bodyLine(page, /productos de la balanza/)), `estado: ${await bodyLine(page, /productos de la balanza \(|productos de la balanza:/)}`);
await page.getByRole("button", { name: /Vincular los \d+ que coinciden/ }).click();
await page.waitForTimeout(2500);
check(/Se vincularon 2 productos/.test(await bodyLine(page, /Se vincularon/)), `botón "Vincular los que coinciden": ${await bodyLine(page, /Se vincularon/)}`);
await page.screenshot({ path: "../../tests/e2e/balanza-vinculos.png", fullPage: false });

// 2. Mostrador: ticket REAL 3095.
await page.getByRole("button", { name: /^Mostrador$/ }).first().click();
await page.waitForTimeout(3000);
const box = page.getByPlaceholder(/Escane|Buscar|código/i).first();
const scan = async (p: Page, code: string) => {
  const b = p.getByPlaceholder(/Escane|Buscar|código/i).first();
  await b.fill(code);
  await b.press("Enter");
  await p.waitForTimeout(700);
};
const charge = async (p: Page) => {
  await p.getByRole("button", { name: /Efectivo/ }).first().click();
  await p.getByPlaceholder(/Recibiste/).first().fill("500000");
  await p.getByRole("button", { name: /^(Cobrar|Confirmar cobro)/ }).first().click();
  await p.waitForTimeout(700);
  if (await p.getByRole("button", { name: /^Confirmar cobro/ }).count()) await p.getByRole("button", { name: /^Confirmar cobro/ }).first().click();
  await p.waitForTimeout(3500);
};
const s2 = await stockOf("2"), s5 = await stockOf("5");
await scan(page, item(2, 1));
await scan(page, item(5, 0.215));
await page.screenshot({ path: "../../tests/e2e/balanza-esperando-total.png" });
check(/Esperando el TOTAL/.test(await page.locator("body").innerText()), "los dos artículos quedan \"Esperando el TOTAL\"");
await page.getByRole("button", { name: /Efectivo/ }).first().click();
await page.getByPlaceholder(/Recibiste/).first().fill("500000");
await page.getByRole("button", { name: /^(Cobrar|Confirmar cobro)/ }).first().click();
await page.waitForTimeout(800);
check(/Falta escanear el código del TOTAL/.test(await bodyLine(page, /TOTAL/)), "sin el TOTAL no deja cobrar");
await scan(page, "2202000731184");
await page.screenshot({ path: "../../tests/e2e/balanza-confirmado.png" });
check(/confirmado: \$\s?73\.118/.test(await bodyLine(page, /confirmado/)), `TOTAL REAL 2202000731184: ${await bodyLine(page, /confirmado|No se confirmó/)}`);
await charge(page);
let sale = await lastSale();
check(sale.total === 73118 && sale.claims === 1 && sale.items.sort().join(" | ") === "2 1 $72000 | 5 0.215 $1118", `venta: $${sale.total}, ${sale.items.join(" · ")}, papeles ${sale.claims}`);
check((await stockOf("2")) === s2 - 1 && Math.round(((await stockOf("5")) - (s5 - 0.215)) * 1000) === 0, "stock: -1 cajón y -0,215 kg de trozadito, una sola vez");

// 3. El mismo papel otra vez enseguida (ej. la 2.ª copia que imprime la balanza): pregunta al escanear el TOTAL.
//    "Cancelar" = no se agrega nada.
await scan(page, item(5, 0.215));
await scan(page, item(2, 1));
answers.push(false);
await scan(page, "2202000731184");
check(dialogs.some((d) => /ya se cobró en esta caja hace/.test(d)), `aviso al escanear el TOTAL: "${dialogs.find((d) => /ya se cobró/.test(d)) ?? "NO APARECIÓ"}"`);
await page.screenshot({ path: "../../tests/e2e/balanza-repetido.png" });
check(/No se agregó: ese ticket de la balanza ya estaba cobrado/.test(await bodyLine(page, /No se agregó/)) && !(await page.getByRole("button", { name: /Cancelar ticket/ }).count()), `al cancelar: "${await bodyLine(page, /No se agregó/)}" y el ticket queda vacío`);
check((await lastSale()).id === sale.id, "no se cobró otra vez");

// 3b. Dos artículos IGUALES con precio a mano que suma como la lista (REAL 08/10, ticket 2300: $74.000 + $70.000):
//     no reparte solo; pregunta. Cancelar → se escriben los importes del papel.
answers.push(false, "74000", "70000");
await scan(page, item(2, 1));
await scan(page, item(2, 1));
await scan(page, total(2, 144000));
check(dialogs.some((d) => /Mirá el ticket impreso: 2 × .*\$72\.000 cada uno/.test(d)), `artículos iguales: "${dialogs.find((d) => /Mirá el ticket/.test(d)) ?? "NO PREGUNTÓ"}"`);
await charge(page);
sale = await lastSale();
check(sale.items.sort().join(" | ") === "2 1 $70000 | 2 1 $74000", `importes reales del papel: ${sale.items.join(" · ")}`);

// 4. Mayorista (REAL 3087 en parte): cajón a lista 2.
await scan(page, item(2, 1));
await scan(page, total(1, 68000));
check(/confirmado: \$\s?68\.000/.test(await bodyLine(page, /confirmado/)), `cajón a precio mayorista: ${await bodyLine(page, /confirmado|No se confirmó/)}`);
await page.getByRole("button", { name: /Cancelar ticket/ }).first().click();
await page.waitForTimeout(500);

// 5. Precio a mano (REAL 08/10: dos cajones $74.000 + $70.000): copia del papel, tiene que sumar.
answers.push("74000", "66000");
await scan(page, item(2, 1));
await scan(page, item(2, 1));
await scan(page, total(2, 140000));
check(/confirmado: \$\s?140\.000/.test(await bodyLine(page, /confirmado/)), `precio a mano pide el papel: ${await bodyLine(page, /confirmado|No se confirmó/)}`);
await charge(page);
sale = await lastSale();
check(sale.items.sort().join(" | ") === "2 1 $66000 | 2 1 $74000", `precio a mano guardado: ${sale.items.join(" · ")}`);

// 6. Venta libre (genérico sin código): falta 1 artículo → "¿es venta libre?" → importe.
const s2b = await stockOf("2");
answers.push(true, "6500");
await scan(page, item(2, 1));
await scan(page, total(2, 78500));
check(/confirmado: \$\s?78\.500/.test(await bodyLine(page, /confirmado/)), `venta libre: ${await bodyLine(page, /confirmado|No se confirmó/)}`);
await charge(page);
sale = await lastSale();
check(sale.items.sort().join(" | ") === "2 1 $72000 | libre 1 $6500" && (await stockOf("2")) === s2b - 1, `venta libre sin stock: ${sale.items.join(" · ")}`);

// 7. Errores de lectura: no agrega nada.
const good = item(5, 0.5);
await scan(page, good.slice(0, 12) + ((Number(good[12]) + 1) % 10));
check(/verificador/.test(await bodyLine(page, /No se agregó/)), `código mal leído: ${await bodyLine(page, /No se agregó/)}`);
await sb.rpc("set_scale_links", { p_branch_id: branch, p_scale_key: "systel-20", p_links: [{ code: 98, kind: "none" }] });
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await page.waitForTimeout(1500);
await scan(page, withCheckDigit("210098000001"));
check(/no está vinculado/.test(await bodyLine(page, /vinculado/)), `producto sin vínculo: ${await bodyLine(page, /vinculado/)}`);
await sb.rpc("set_scale_links", { p_branch_id: branch, p_scale_key: "systel-20", p_links: [{ code: 98, kind: "product", product_id: await productId("98") }] });

// 8. Sin conexión al cobrar: queda guardada y se sube sola, una sola vez.
const offKg = Math.round((1.25 + salt) * 1000) / 1000;
const s5c = await stockOf("5");
await page.route("**/rest/v1/rpc/create_pos_scale_sale", (r) => r.abort("internetdisconnected"));
await scan(page, item(5, offKg));
await scan(page, total(1, Math.round(offKg * 5200)));
await charge(page);
check(/Sin conexión/.test(await bodyLine(page, /Sin conexión/)), `sin conexión: ${await bodyLine(page, /Sin conexión/)}`);
await page.unroute("**/rest/v1/rpc/create_pos_scale_sale");
await page.evaluate(() => window.dispatchEvent(new Event("online")));
await page.waitForTimeout(5000);
sale = await lastSale();
check(sale.total === Math.round(offKg * 5200) && sale.claims === 1 && Math.round(((await stockOf("5")) - (s5c - offKg)) * 1000) === 0, `al volver la conexión se subió una vez: ${sale.items.join(" · ")}, stock trozadito ${await stockOf("5")}`);

// 9. Dos cajas con el mismo papel nuevo al mismo tiempo.
const caja2 = await openPage();
await caja2.page.getByRole("button", { name: /^Mostrador$/ }).first().click();
await caja2.page.waitForTimeout(3000);
const before2 = (await lastSale()).id;
for (const p of [page, caja2.page]) {
  await scan(p, item(5, 0.5 + salt));
  await scan(p, total(1, Math.round((0.5 + salt) * 5200)));
}
answers.push(false);
caja2.answers.push(false);
await Promise.all([charge(page), charge(caja2.page)]);
const { count: newSales } = await sb.from("pos_sales").select("id", { count: "exact", head: true }).eq("branch_id", branch).gt("created_at", (await sb.from("pos_sales").select("created_at").eq("id", before2).single()).data!.created_at).is("voided_at", null);
check(newSales === 1, `dos cajas, mismo papel: ${newSales} venta (la otra caja recibió el aviso: ${[...dialogs, ...caja2.dialogs].filter((d) => /ya se cobró/.test(d)).length > 1 ? "sí" : "no"})`);

await browser.close();
console.log(failures === 0 ? "\nTODO OK" : `\n${failures} FALLAS`);
