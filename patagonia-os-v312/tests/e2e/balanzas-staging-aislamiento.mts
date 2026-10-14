// STAGING: otra empresa (Don Julio) no ve ni puede usar la balanza de "PRUEBA Balanzas".
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
const readEnv = (p: string) => Object.fromEntries(fs.readFileSync(new URL(p, import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const demo = readEnv("../../.env.demo-staging");
const bal = readEnv("../../.env.balanzas-staging");
const c = createClient(demo.DEMO_SUPABASE_URL, demo.DEMO_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await c.auth.signInWithPassword({ email: demo.DEMO_OWNER_EMAIL, password: demo.DEMO_OWNER_PASSWORD });
for (const t of ["scale_profiles", "scale_catalog_items", "pos_scale_paper_claims"]) {
  const { count } = await c.from(t).select("*", { count: "exact", head: true }).eq("company_id", bal.BAL_COMPANY_ID);
  console.log(count === 0 ? "OK  " : "FALLA", `Don Julio ve ${count} filas de ${t} de otra empresa`);
}
const r = await c.rpc("set_scale_links", { p_branch_id: bal.BAL_BRANCH_ID, p_scale_key: "systel-20", p_links: [{ code: 2, kind: "none" }] });
console.log(r.error ? "OK  " : "FALLA", `Don Julio no puede cambiar vínculos de otra empresa: ${r.error?.message}`);
const anon = createClient(demo.DEMO_SUPABASE_URL, demo.DEMO_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const a = await anon.rpc("create_pos_scale_sale", { p_branch_id: bal.BAL_BRANCH_ID, p_items: [], p_payments: [], p_pos_shift_id: bal.BAL_BRANCH_ID, p_discount_amount: 0, p_surcharge_amount: 0, p_idempotency_key: null, p_scale_key: "x", p_papers: [] });
console.log(a.error ? "OK  " : "FALLA", `sin sesión no se puede vender: ${a.error?.message}`);
