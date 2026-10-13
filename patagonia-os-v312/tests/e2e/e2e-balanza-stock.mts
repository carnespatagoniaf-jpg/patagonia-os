// Circuito balanza → venta → stock contra la base de STAGING (funciones reales), con usuario real de la
// empresa ficticia Don Julio. Usa el MISMO lector que Mostrador (scan-resolve.ts).
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resolveScan } from "../../apps/web/src/features/sale/scan-resolve.ts";
import { CARNES_PATAGONIA_CONFIG, LOS_GRINGOS_LABEL_CONFIG } from "../../apps/web/src/features/sale/scale-real-labels.ts";

const env = Object.fromEntries(
  fs.readFileSync(new URL("../../.env.demo-staging", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const sb = createClient(env.DEMO_SUPABASE_URL, env.DEMO_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { error: le } = await sb.auth.signInWithPassword({ email: env.DEMO_OWNER_EMAIL, password: env.DEMO_OWNER_PASSWORD });
if (le) throw le;
const branchId = env.DEMO_BRANCH_ID;

const out: string[] = [];
const log = (s: string) => { out.push(s); console.log(s); };
const ok = (cond: boolean, what: string) => { log(`${cond ? "✔" : "✖"} ${what}`); if (!cond) process.exitCode = 1; };

async function products() {
  const { data, error } = await sb.from("products_with_stock").select("id, code, name, unit, price_retail, active, stock, branch_id").eq("branch_id", branchId);
  if (error) throw error;
  return data.map((p: any) => ({ id: p.id, code: p.code, name: p.name, unit: p.unit, priceRetail: Number(p.price_retail), active: p.active, stock: Number(p.stock) }));
}
async function stockOf(code: string) { return (await products()).find((p) => p.code === code)!.stock; }
async function movementsFor(saleId: string) {
  const { data } = await sb.from("inventory_movements").select("product_id, movement_type, quantity, branch_id, reference_type").eq("reference_id", saleId);
  return data ?? [];
}

const { data: shifts } = await sb.from("pos_shifts").select("id").eq("branch_id", branchId).eq("status", "open");
let shiftId = shifts?.[0]?.id;
if (!shiftId) { const { data, error } = await sb.rpc("open_pos_shift", { p_branch_id: branchId, p_opening_cash: 0 }); if (error) throw error; shiftId = (data as any).id ?? data; }
const { data: accounts } = await sb.from("treasury_accounts").select("id, name, payment_method, active").eq("active", true);
const cash = accounts!.find((a: any) => a.payment_method === "cash")!;

async function sell(items: { productId: string; quantity: number; source?: string }[], key = crypto.randomUUID()) {
  const prods = await products();
  const total = Math.round(items.reduce((acc, i) => acc + i.quantity * prods.find((p) => p.id === i.productId)!.priceRetail, 0));
  const { data, error } = await sb.rpc("create_pos_sale", {
    p_branch_id: branchId, p_pos_shift_id: shiftId, p_discount_amount: 0, p_surcharge_amount: 0, p_idempotency_key: key,
    p_items: items.map((i) => ({ product_id: i.productId, quantity: i.quantity, discount_amount: 0, source: i.source ?? null, scale_tickets: i.source ? 1 : null })),
    p_payments: [{ account_id: cash.id, amount: total }]
  });
  if (error) throw error;
  return { saleId: (data as any).sale_id as string, total: Number((data as any).total), key };
}
async function setStock(code: string, qty: number) {
  const p = (await products()).find((x) => x.code === code)!;
  const { error } = await sb.rpc("adjust_product_stock", { p_branch_id: branchId, p_product_id: p.id, p_counted_quantity: qty, p_reason: "Prueba circuito balanza (staging)" });
  if (error) throw error;
}

log(`Staging · empresa ficticia Don Julio · sucursal ${branchId} · turno ${shiftId} · cobro en ${cash.name}`);

// ---------- 1. Etiqueta REAL (Carnes Patagonia, Kretz, 1-6-5): producto 1, 0,796 kg ----------
await setStock("1", 10);
const realLabel = "2000001007969";
let prods = await products();
let r = resolveScan(realLabel, prods as any, CARNES_PATAGONIA_CONFIG);
ok(r.type === "label", `[REAL] etiqueta ${realLabel} se reconoce como etiqueta de balanza`);
const asado = (r as any).product;
const qty = (r as any).quantity as number;
log(`   producto: ${asado.code} ${asado.name} (${asado.unit}) · cantidad: ${qty} kg · precio $${asado.priceRetail}`);
const before1 = await stockOf("1");
const sale1 = await sell([{ productId: asado.id, quantity: qty, source: "scale" }]);
const after1 = await stockOf("1");
log(`   stock antes: ${before1} kg · venta ${sale1.saleId} $${sale1.total} · stock después: ${after1} kg`);
ok(Math.abs(before1 - qty - after1) < 0.0005, `descuenta exactamente ${qty} kg`);
const mov1 = await movementsFor(sale1.saleId);
ok(mov1.length === 1 && mov1[0].branch_id === branchId && mov1[0].movement_type === "sale" && Number(mov1[0].quantity) === -qty, `un solo movimiento 'sale' de -${qty} en la sucursal de la venta`);

// ---------- 2. Reintento con la MISMA clave: no duplica ----------
const again = await sell([{ productId: asado.id, quantity: qty, source: "scale" }], sale1.key);
const after2 = await stockOf("1");
ok(again.saleId === sale1.saleId && Math.abs(after2 - after1) < 0.0005, `reintento con la misma clave: misma venta (${again.saleId.slice(0, 8)}…), stock sin cambio (${after2} kg)`);
// Dos a la vez con la misma clave (doble clic / reintento simultáneo)
const k = crypto.randomUUID();
const both = await Promise.allSettled([sell([{ productId: asado.id, quantity: 0.5 }], k), sell([{ productId: asado.id, quantity: 0.5 }], k)]);
const after2b = await stockOf("1");
const okIds = both.filter((x) => x.status === "fulfilled").map((x: any) => x.value.saleId);
ok(Math.abs(after2 - 0.5 - after2b) < 0.0005, `dos envíos SIMULTÁNEOS con la misma clave: se descuenta una sola vez (${after2} → ${after2b}); resultados: ${both.map((x) => x.status).join(", ")}${okIds.length === 2 ? `, misma venta: ${okIds[0] === okIds[1]}` : ""}`);

// ---------- 3. Anular una venta confirmada: repone ----------
const { error: ve } = await sb.rpc("void_pos_sale", { p_sale_id: sale1.saleId });
if (ve) throw ve;
const after3 = await stockOf("1");
ok(Math.abs(after3 - (after2b + qty)) < 0.0005, `anular la venta repone ${qty} kg (${after2b} → ${after3})`);
const mov3 = (await movementsFor(sale1.saleId)).filter((m: any) => m.movement_type === "sale_void");
ok(mov3.length === 1 && mov3[0].branch_id === branchId, "un movimiento 'sale_void' en la misma sucursal");

// ---------- 4. Cancelar sin confirmar: no toca el stock ----------
const before4 = await stockOf("1");
prods = await products();
r = resolveScan("2000001012604", prods as any, CARNES_PATAGONIA_CONFIG); // REAL, 1,260 kg, se escanea pero NO se cobra
const after4 = await stockOf("1");
ok(r.type === "label" && before4 === after4, `[REAL] escanear y cancelar sin cobrar: stock igual (${before4} = ${after4})`);

// ---------- 5. Código desconocido o mal leído: error, sin cambio ----------
const before5 = await stockOf("1");
const bad = [
  ["2000504011722", "[REAL] etiqueta de un producto (504) que no existe en esta empresa"],
  ["2000001007968", "etiqueta REAL con un dígito mal leído (verificador incorrecto)"],
  ["7791234567890", "código de fábrica que no es de ningún producto"]
];
for (const [code, what] of bad) {
  const x = resolveScan(code, (await products()) as any, CARNES_PATAGONIA_CONFIG);
  ok(x.type === "error" || x.type === "search", `${what}: ${x.type === "error" ? `error "${(x as any).message.slice(0, 70)}…"` : "no se reconoce (Mostrador: 'No se encontró ningún producto con ese código')"}`);
}
ok((await stockOf("1")) === before5, `stock sin cambios después de los códigos malos (${before5})`);

// ---------- 6. Producto POR UNIDAD (formato Systel 21, SINTÉTICO: no hay etiqueta real) ----------
await setStock("53", 20);
const unitLabel = (() => { const f = "210053002000"; const d = f.split("").map(Number); const s = d.reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0); return f + ((10 - (s % 10)) % 10); })();
const ru = resolveScan(unitLabel, (await products()) as any, LOS_GRINGOS_LABEL_CONFIG);
ok(ru.type === "label" && (ru as any).quantity === 2, `[SINTÉTICO] ${unitLabel} = ${(ru as any).product?.name} x ${(ru as any).quantity}`);
const before6 = await stockOf("53");
const sale6 = await sell([{ productId: (ru as any).product.id, quantity: 2, source: "scale" }]);
const after6 = await stockOf("53");
ok(before6 - 2 === after6, `por unidad: ${before6} → ${after6} (venta ${sale6.saleId.slice(0, 8)}…, $${sale6.total})`);
await sb.rpc("void_pos_sale", { p_sale_id: sale6.saleId });
ok((await stockOf("53")) === before6, `anulada: vuelve a ${before6}`);

await sb.auth.signOut();
