// STAGING, empresa aislada "PRUEBA Balanzas": venta con balanza de PRESENTACIONES, como las armó Los gringos el 14/10
// (CAJON PATA MUSLO x15 = 15 kg de PATA MUSLO x1x2; PATA MUSLO x5x10 = mismo stock, factor 1). El papel se cobra por
// create_pos_scale_sale y el stock tiene que bajar del producto PRINCIPAL, una sola vez.
import fs from "node:fs";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
const readEnv = (p: string) => Object.fromEntries(fs.readFileSync(new URL(p, import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const env = readEnv("../../.env.balanzas-staging");
const sb = createClient(env.BAL_SUPABASE_URL, readEnv("../../.env.demo-staging").DEMO_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await sb.auth.signInWithPassword({ email: env.BAL_EMAIL, password: env.BAL_PASSWORD });
const branch = env.BAL_BRANCH_ID;
const prod = async (code: string) => (await sb.from("products_with_stock").select("id, stock").eq("branch_id", branch).eq("code", code).single()).data as { id: string; stock: number };
const [p7, p8, p9] = [await prod("7"), await prod("8"), await prod("9")];
for (const [p, f] of [[p8, 1], [p9, 15]] as const) {
  const r = await sb.rpc("set_product_stock_source", { p_product_id: p.id, p_source_id: p7.id, p_factor: f, p_move_stock: false });
  if (r.error) console.log("presentación:", r.error.message);
}
await sb.rpc("adjust_product_stock", { p_branch_id: branch, p_product_id: p7.id, p_counted_quantity: 500, p_reason: "Prueba presentaciones (staging)" });
const before = Number((await prod("7")).stock);
const { data: shift } = await sb.from("pos_shifts").select("id").eq("branch_id", branch).eq("status", "open").single();
const fp = `presentaciones-${crypto.randomUUID()}`;
const items = [
  { product_id: p9.id, quantity: 1, discount_amount: 0, source: "scale", scale_tickets: 1, scale_amount: 54000, scale_ticket: `${fp}#0`, scale_code: 9 },
  { product_id: p8.id, quantity: 2.345, discount_amount: 0, source: "scale", scale_tickets: 1, scale_amount: 8442, scale_ticket: `${fp}#1`, scale_code: 8 }
];
const payload = { p_branch_id: branch, p_items: items, p_payments: [{ account_id: env.BAL_CASH_ACCOUNT_ID, amount: 62442, reference: null }], p_pos_shift_id: shift!.id, p_discount_amount: 0, p_surcharge_amount: 0, p_idempotency_key: crypto.randomUUID(), p_scale_key: "systel-20", p_papers: [{ fingerprint: fp, ticket_date: new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10), total: 62442, articles: 2, repeat_confirmed: false, items: [0, 1] }] };
const r1 = await sb.rpc("create_pos_scale_sale", payload);
const r2 = await sb.rpc("create_pos_scale_sale", payload);
const after = Number((await prod("7")).stock);
const ok = !r1.error && r2.data?.sale_id === r1.data?.sale_id && Math.round((before - after) * 1000) === Math.round((15 + 2.345) * 1000);
console.log(ok ? "OK  " : "FALLA", `cajón x15 (1 u.) + pata muslo x5x10 (2,345 kg) → el principal bajó ${Math.round((before - after) * 1000) / 1000} kg (esperado 17,345), una sola vez aunque se reintentó ${r1.error?.message ?? ""}`);
if (!r1.error) await sb.rpc("void_pos_sale", { p_sale_id: r1.data.sale_id });
console.log(Number((await prod("7")).stock) === before ? "OK  " : "FALLA", "anulada: el principal vuelve a su stock");
