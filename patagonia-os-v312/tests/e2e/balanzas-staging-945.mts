// Prueba de punta a punta contra STAGING (empresa aislada "PRUEBA Balanzas (staging)", nunca producción):
// los 945 tickets REALES de Los gringos (07-13/10) se cobran por la RPC real create_pos_scale_sale, como lo
// haría Mostrador: código de cada artículo + TOTAL, con la balanza configurada como hace falta (20/21PPPPCCCCCC).
// Además: reintentos, dos cajas a la vez, rechazos del servidor y anulación.
// Corre desde patagonia-os-v312/apps/web: npx tsx ../../tests/e2e/balanzas-staging-945.mts
import fs from "node:fs";
import crypto from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mirrorLinks, realTickets, targetProfile } from "../../apps/web/src/features/scales/sale/los-gringos-fixture";
import { replayTicket } from "../../apps/web/src/features/scales/sale/los-gringos-replay";
import type { Product } from "@patagonia/domain";

const readEnv = (p: string) => Object.fromEntries(fs.readFileSync(new URL(p, import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const env = readEnv("../../.env.balanzas-staging");
const anon = readEnv("../../.env.demo-staging").DEMO_SUPABASE_ANON_KEY;
if (!env.BAL_SUPABASE_URL.includes("loquhcwsvsbqpinefxcc")) throw new Error("Esta prueba solo corre contra STAGING");
const SCALE = "systel-20";
const branch = env.BAL_BRANCH_ID;

async function login(): Promise<SupabaseClient> {
  const c = createClient(env.BAL_SUPABASE_URL, anon, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email: env.BAL_EMAIL, password: env.BAL_PASSWORD });
  if (error) throw error;
  return c;
}
const sb = await login();
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "OK  " : "FALLA"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

// 1. Productos (uno por producto de la balanza, mismo código) con stock inicial conocido.
const profile = targetProfile();
const { data: existing, error: exErr } = await sb.from("products_with_stock").select("id, code").eq("branch_id", branch);
if (exErr) throw exErr;
const byCode = new Map((existing ?? []).map((p: { id: string; code: string }) => [p.code, p.id]));
for (const it of profile.catalog) {
  if (byCode.has(String(it.code))) continue;
  const { data, error } = await sb.rpc("create_product", { p_branch_id: branch, p_code: String(it.code), p_name: `PRUEBA ${it.name.trim()}`, p_unit: it.saleType === "U" ? "unit" : "kg", p_cost: 0, p_price_retail: it.prices[0], p_min_stock: 0, p_category_id: null });
  if (error) throw error;
  byCode.set(String(it.code), data.id);
}
const START = 1000;
for (const [, id] of byCode) await sb.rpc("adjust_product_stock", { p_branch_id: branch, p_product_id: id, p_counted_quantity: START, p_reason: "Inicio prueba 945 tickets (staging)" });
const products: Product[] = profile.catalog.map((i) => ({ id: byCode.get(String(i.code))!, code: String(i.code), name: i.name, unit: i.saleType === "U" ? "unit" : "kg", cost: 0, priceRetail: i.prices[0], stock: START, minStock: 0, active: true }));
const links = mirrorLinks(profile.catalog).map((l) => ({ ...l, productId: byCode.get(String(l.code))! }));

// 2. Catálogo de la balanza y vínculos (como lo harían la lectura y la pantalla de vinculación).
let r: { data: unknown; error: { message: string } | null } = await sb.rpc("save_scale_catalog", {
  p_branch_id: branch, p_scale_key: SCALE,
  p_profile: { brand: "systel", model: "Cuora Max", weighed_format: profile.weighedFormat, unit_format: profile.unitFormat, total_format: profile.totalFormat, amount_decimals: 0, generic_codes: profile.genericCodes },
  p_items: profile.catalog.map((i) => ({ code: i.code, name: i.name, sale_type: i.saleType, prices: i.prices, ean_type: i.eanType, ean_config: i.eanConfig }))
});
check(!r.error, `catálogo guardado (${profile.catalog.length} productos) ${r.error?.message ?? ""}`);
r = await sb.rpc("set_scale_links", { p_branch_id: branch, p_scale_key: SCALE, p_links: links.map((l) => ({ code: l.code, kind: "product", product_id: l.productId })) });
check(!r.error, `vínculos guardados ${r.error?.message ?? ""}`);
const wrongLink = await sb.rpc("set_scale_links", { p_branch_id: branch, p_scale_key: SCALE, p_links: [{ code: 2, kind: "product", product_id: byCode.get("5") }] });
check(!!wrongLink.error && /por unidad en la balanza/.test(wrongLink.error.message), `el servidor rechaza vincular un unitario con un producto por kg: "${wrongLink.error?.message}"`);

// 3. Turno abierto.
const { data: open } = await sb.from("pos_shifts").select("id").eq("branch_id", branch).eq("status", "open").maybeSingle();
const shift = open?.id ?? (await sb.rpc("open_pos_shift", { p_branch_id: branch, p_opening_cash: 0 })).data.id;
const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

type Payload = Record<string, unknown>;
function buildSale(t: ReturnType<typeof realTickets>[number], opts: { confirm?: boolean; key?: string } = {}): { payload: Payload; total: number; ok: boolean; problem?: string } {
  const rep = replayTicket(t, profile, links, products);
  if (!rep.ok) return { payload: {}, total: 0, ok: false, problem: rep.problem };
  const printed = t.lines.filter((l) => l.amount > 0 || l.units > 0 || l.grams > 0);
  const fp = `${t.date}|${rep.fingerprint}`;
  const items = rep.lines.map((l, i) =>
    l.productId
      ? { product_id: l.productId, quantity: l.quantity, discount_amount: 0, source: "scale", scale_tickets: 1, scale_amount: l.amount, scale_ticket: `${fp}#${i}`, scale_code: printed[i].plu }
      : { description: "Venta libre de la balanza", unit_price: l.amount, quantity: 1, discount_amount: 0, scale_code: null }
  );
  const total = rep.lines.reduce((s, l) => s + l.amount, 0);
  return {
    ok: true,
    total,
    payload: {
      p_branch_id: branch, p_items: items, p_payments: [{ account_id: env.BAL_CASH_ACCOUNT_ID, amount: total, reference: null }],
      p_pos_shift_id: shift, p_discount_amount: 0, p_surcharge_amount: 0, p_idempotency_key: opts.key ?? crypto.randomUUID(), p_scale_key: SCALE,
      p_papers: [{ fingerprint: fp, ticket_date: today, total, articles: printed.length, repeat_confirmed: !!opts.confirm, items: items.map((_, i) => i) }]
    }
  };
}

const stockNow = async () => {
  const { data } = await sb.from("products_with_stock").select("id, stock").eq("branch_id", branch);
  return new Map((data ?? []).map((p: { id: string; stock: number }) => [p.id, Number(p.stock)]));
};
const before = await stockNow();

// 4. Los 945 tickets.
const tickets = realTickets();
let sold = 0, repeatedAsked = 0, failed = 0, money = 0;
const expectedDelta = new Map<string, number>();
const saleIds: string[] = [];
const t0 = Date.now();
for (const t of tickets) {
  const s = buildSale(t);
  if (!s.ok) { failed++; console.log("  no se pudo armar", t.key, s.problem); continue; }
  let res = await sb.rpc("create_pos_scale_sale", s.payload);
  if (res.error && /TICKET_BALANZA_REPETIDO/.test(res.error.message)) {
    repeatedAsked++;
    (s.payload.p_papers as Payload[])[0].repeat_confirmed = true; // el cajero contesta "es otro ticket igual"
    res = await sb.rpc("create_pos_scale_sale", s.payload);
  }
  if (res.error) { failed++; console.log("  rechazada", t.key, res.error.message); continue; }
  sold++;
  saleIds.push(res.data.sale_id);
  money += Number(res.data.total);
  for (const it of s.payload.p_items as Array<{ product_id?: string; quantity: number }>) if (it.product_id) expectedDelta.set(it.product_id, (expectedDelta.get(it.product_id) ?? 0) + it.quantity);
}
const realMoney = tickets.reduce((s, t) => s + t.lines.reduce((a, l) => a + l.amount, 0), 0);
check(sold === 945 && failed === 0, `945 tickets reales cobrados: ${sold} (fallas ${failed}) en ${Math.round((Date.now() - t0) / 1000)} s`);
check(Math.round(money) === Math.round(realMoney), `plata cobrada $${money.toLocaleString("es-AR")} = vendido en la balanza $${realMoney.toLocaleString("es-AR")}`);
check(repeatedAsked === 94, `"¿es otro ticket igual?" se preguntó ${repeatedAsked} veces (esperado 94: mismos papeles el mismo día)`);
const after = await stockNow();
let stockOk = 0, stockBad = 0;
for (const p of products) {
  const d = Math.round(((before.get(p.id) ?? 0) - (after.get(p.id) ?? 0)) * 1000);
  const e = Math.round((expectedDelta.get(p.id) ?? 0) * 1000);
  if (d === e) stockOk++; else { stockBad++; console.log("  stock distinto", p.code, d / 1000, "esperado", e / 1000); }
}
check(stockBad === 0, `stock: los ${stockOk} productos bajaron exactamente lo vendido (incluye 0 para los no vendidos)`);
let claims = 0;
for (let i = 0; i < saleIds.length; i += 100) {
  const { count } = await sb.from("pos_scale_paper_claims").select("id", { count: "exact", head: true }).in("sale_id", saleIds.slice(i, i + 100));
  claims += count ?? 0;
}
check(claims === saleIds.length, `cada venta tiene su papel registrado (${claims} de ${saleIds.length})`);

// 5. Reintento con la misma clave (sin conexión / doble clic): misma venta, el stock no vuelve a bajar.
const extra = tickets.find((t) => t.key === "13/10/26#000003095")!;
const key = crypto.randomUUID();
const once = buildSale(extra, { confirm: true, key });
const s1 = await sb.rpc("create_pos_scale_sale", once.payload);
const st1 = await stockNow();
const s2 = await sb.rpc("create_pos_scale_sale", once.payload);
const [s3, s4] = await Promise.all([sb.rpc("create_pos_scale_sale", once.payload), sb.rpc("create_pos_scale_sale", once.payload)]);
const st2 = await stockNow();
check(!s1.error && s2.data?.sale_id === s1.data?.sale_id && s3.data?.sale_id === s1.data?.sale_id && s4.data?.sale_id === s1.data?.sale_id, "reintentos con la misma clave (también 2 a la vez): devuelven la misma venta");
check([...st1].every(([id, q]) => st2.get(id) === q), "reintentos: el stock no se descuenta otra vez");

// 6. Dos cajas con el mismo papel nuevo al mismo tiempo (cada una con su sesión): una cobra, la otra recibe "repetido".
const caja2 = await login();
const nuevo = { ...extra, date: "99/99/99" };
const a = buildSale(nuevo);
const b = buildSale(nuevo);
const [ra, rb] = await Promise.all([sb.rpc("create_pos_scale_sale", a.payload), caja2.rpc("create_pos_scale_sale", b.payload)]);
const okCount = [ra, rb].filter((x) => !x.error).length;
const repCount = [ra, rb].filter((x) => x.error && /TICKET_BALANZA_REPETIDO/.test(x.error.message)).length;
check(okCount === 1 && repCount === 1, `dos cajas, mismo papel, al mismo tiempo: ${okCount} cobro y ${repCount} aviso de repetido`);

// 7. Anular libera el papel: después se puede cobrar sin el aviso.
const okSale = (ra.error ? rb : ra).data.sale_id;
const v = await sb.rpc("void_pos_sale", { p_sale_id: okSale });
const again = await sb.rpc("create_pos_scale_sale", buildSale(nuevo).payload);
check(!v.error && !again.error, `venta anulada: el mismo papel se vuelve a cobrar sin aviso ${v.error?.message ?? ""} ${again.error?.message ?? ""}`);

// 8. Rechazos del servidor (aunque la pantalla tuviera un error): sin venta y sin tocar stock.
const stBefore = await stockNow();
const bad = (mut: (p: Payload) => void) => {
  const s = buildSale({ ...extra, date: `rechazo-${crypto.randomUUID()}` }, { confirm: true });
  mut(s.payload);
  return sb.rpc("create_pos_scale_sale", s.payload);
};
const cases: Array<[string, (p: Payload) => void, RegExp]> = [
  ["los artículos no suman el TOTAL", (p) => ((p.p_papers as Payload[])[0].total = 73119), /suman/],
  ["falta un artículo (cantidad del TOTAL)", (p) => ((p.p_papers as Payload[])[0].articles = 3), /artículos/],
  ["producto distinto del vinculado", (p) => (((p.p_items as Payload[])[0]).product_id = byCode.get("3")), /no está vinculado/],
  ["artículo de balanza fuera de su ticket", (p) => { (p.p_items as Payload[]).push({ ...(p.p_items as Payload[])[1] }); (p.p_payments as Payload[])[0].amount = 74236; }, /fuera de su ticket/],
  ["descuento en un artículo de balanza", (p) => (((p.p_items as Payload[])[0]).discount_amount = 100), /descuento/],
  ["venta libre con código de un producto común", (p) => { (p.p_items as Payload[]).push({ description: "x", unit_price: 1, quantity: 1, discount_amount: 0, scale_code: 5 }); ((p.p_papers as Payload[])[0].items as number[]).push(2); (p.p_papers as Payload[])[0].total = 73119; (p.p_papers as Payload[])[0].articles = 3; (p.p_payments as Payload[])[0].amount = 73119; }, /no es una venta libre/],
  ["fecha de ticket vieja", (p) => ((p.p_papers as Payload[])[0].ticket_date = "2026-10-01"), /Fecha/]
];
for (const [name, mut, re] of cases) {
  const res = await bad(mut);
  check(!!res.error && re.test(res.error.message), `rechaza: ${name} → "${res.error?.message ?? "¡NO RECHAZÓ!"}"`);
}
const stAfterBad = await stockNow();
check([...stBefore].every(([id, q]) => stAfterBad.get(id) === q), "los rechazos no tocaron el stock");

// 9. Limpieza: se anulan todas las ventas de la prueba (staging) para poder repetirla.
const { data: mine } = await sb.from("pos_sales").select("id").eq("branch_id", branch).is("voided_at", null);
for (const s of mine ?? []) await sb.rpc("void_pos_sale", { p_sale_id: s.id });
console.log(`limpieza: ${mine?.length ?? 0} ventas de prueba anuladas`);
