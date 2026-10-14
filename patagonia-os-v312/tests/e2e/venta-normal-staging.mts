// STAGING: una venta normal de Mostrador (create_pos_sale) en la empresa de prueba: cobra, descuenta stock y se anula.
import fs from "node:fs";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
const readEnv = (p: string) => Object.fromEntries(fs.readFileSync(new URL(p, import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const env = readEnv("../../.env.balanzas-staging");
const sb = createClient(env.BAL_SUPABASE_URL, readEnv("../../.env.demo-staging").DEMO_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await sb.auth.signInWithPassword({ email: env.BAL_EMAIL, password: env.BAL_PASSWORD });
const { data: prod } = await sb.from("products_with_stock").select("id, stock, price_retail").eq("branch_id", env.BAL_BRANCH_ID).eq("code", "2").single();
const { data: shift } = await sb.from("pos_shifts").select("id").eq("branch_id", env.BAL_BRANCH_ID).eq("status", "open").single();
const r = await sb.rpc("create_pos_sale", { p_branch_id: env.BAL_BRANCH_ID, p_items: [{ product_id: prod!.id, quantity: 1, discount_amount: 0 }], p_payments: [{ account_id: env.BAL_CASH_ACCOUNT_ID, amount: Number(prod!.price_retail), reference: null }], p_pos_shift_id: shift!.id, p_discount_amount: 0, p_surcharge_amount: 0, p_idempotency_key: crypto.randomUUID() });
const after = (await sb.from("products_with_stock").select("stock").eq("id", prod!.id).eq("branch_id", env.BAL_BRANCH_ID).single()).data!.stock;
console.log(!r.error && Number(after) === Number(prod!.stock) - 1 ? "OK  " : "FALLA", `venta normal: ${r.error?.message ?? `$${r.data.total}, stock ${prod!.stock} → ${after}`}`);
if (!r.error) {
  await sb.rpc("void_pos_sale", { p_sale_id: r.data.sale_id });
  const back = (await sb.from("products_with_stock").select("stock").eq("id", prod!.id).eq("branch_id", env.BAL_BRANCH_ID).single()).data!.stock;
  console.log(Number(back) === Number(prod!.stock) ? "OK  " : "FALLA", `anulada: stock vuelve a ${back}`);
}
