import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { toError } from "../../lib/supabase-error";
import { storedForSale, type FreezerPackage, type FreezerStatus, type FreezerStored } from "./freezer-logic";

// Freezer (migración 214, pantalla a pedido 'freezer'). Se lee directo de la tabla (RLS: empresa + pantalla prendida)
// y se escribe solo por RPC. Sin la migración, la web sigue andando: listas vacías.

interface Row {
  id: string;
  product_id: string;
  quantity: number | string;
  code: string | null;
  status: FreezerStatus;
  stored_at: string;
  out_at: string | null;
  out_reason: string | null;
  pos_sale_id: string | null;
}

const COLUMNS = "id,product_id,quantity,code,status,stored_at,out_at,out_reason,pos_sale_id";

const missingTable = (error: { code?: string } | null) => !!error && (error.code === "42P01" || error.code === "PGRST205");

// Modo demostración (sin base): el freezer vive en este navegador, para probar la pantalla y grabar los videos.
const DEMO_KEY = "patagonia-demo-freezer";
function demoRead(): FreezerPackage[] {
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY) ?? "[]") as FreezerPackage[];
  } catch {
    return [];
  }
}
function demoWrite(list: FreezerPackage[]) {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(list));
  } catch {
    // sin almacenamiento
  }
}

function client() {
  if (!supabase) throw new Error("Sin conexión con la base");
  return supabase;
}

const map = (r: Row): FreezerPackage => ({
  id: r.id,
  productId: r.product_id,
  quantity: Number(r.quantity),
  code: r.code,
  status: r.status,
  storedAt: r.stored_at,
  outAt: r.out_at,
  outReason: r.out_reason,
  posSaleId: r.pos_sale_id
});

/** Lo guardado en el freezer del local, más lo que salió en los últimos 30 días (para "Lo último que salió"). */
export async function listFreezer(branchId: string): Promise<FreezerPackage[]> {
  if (!isSupabaseConfigured) return demoRead();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client()
    .from("freezer_packages")
    .select(COLUMNS)
    .eq("branch_id", branchId)
    .or(`status.eq.guardado,out_at.gte.${since}`)
    .order("stored_at", { ascending: true })
    .limit(3000);
  if (missingTable(error)) return [];
  if (error) throw toError(error);
  return ((data ?? []) as Row[]).map(map);
}

export async function storeInFreezer(branchId: string, items: { productId: string; quantity: number; code: string }[]): Promise<{ packages: number; kg: number }> {
  if (!isSupabaseConfigured) {
    const now = new Date().toISOString();
    const added = items.map((i, n): FreezerPackage => ({ id: `demo-${Date.now()}-${n}`, productId: i.productId, quantity: i.quantity, code: i.code || null, status: "guardado", storedAt: now, outAt: null, outReason: null, posSaleId: null }));
    demoWrite([...demoRead(), ...added]);
    return { packages: added.length, kg: 0 };
  }
  const { data, error } = await client().rpc("freezer_store", {
    p_branch_id: branchId,
    p_items: items.map((i) => ({ product_id: i.productId, quantity: i.quantity, code: i.code || null }))
  });
  if (error) throw toError(error);
  const r = (data ?? {}) as { packages?: number; kg?: number | string };
  return { packages: Number(r.packages ?? 0), kg: Number(r.kg ?? 0) };
}

export async function takeOutOfFreezer(ids: string[], reason: string): Promise<number> {
  if (!isSupabaseConfigured) {
    const now = new Date().toISOString();
    demoWrite(demoRead().map((p) => (ids.includes(p.id) && p.status === "guardado" ? { ...p, status: "sacado", outAt: now, outReason: reason } : p)));
    return ids.length;
  }
  const { data, error } = await client().rpc("freezer_take_out", { p_package_ids: ids, p_reason: reason });
  if (error) throw toError(error);
  return Number(data ?? 0);
}

export async function putBackInFreezer(id: string): Promise<void> {
  if (!isSupabaseConfigured) {
    demoWrite(demoRead().map((p) => (p.id === id && p.status === "sacado" ? { ...p, status: "guardado", outAt: null, outReason: null } : p)));
    return;
  }
  const { error } = await client().rpc("freezer_put_back", { p_package_id: id });
  if (error) throw toError(error);
}

// Mostrador: las etiquetas guardadas del local, también sin conexión (la última lista que se pudo leer).
const CACHE_KEY = (branchId: string) => `patagonia-freezer-${branchId}`;

export function cachedFreezerStored(branchId: string): FreezerStored[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY(branchId));
    return raw ? (JSON.parse(raw) as FreezerStored[]) : [];
  } catch {
    return [];
  }
}

export async function loadFreezerStored(branchId: string): Promise<FreezerStored[]> {
  if (!isSupabaseConfigured) return storedForSale(demoRead());
  const { data, error } = await client()
    .from("freezer_packages")
    .select(COLUMNS)
    .eq("branch_id", branchId)
    .eq("status", "guardado")
    .not("code", "is", null)
    .order("stored_at", { ascending: true })
    .limit(3000);
  if (missingTable(error)) return [];
  if (error) throw toError(error);
  const list = storedForSale(((data ?? []) as Row[]).map(map));
  try {
    localStorage.setItem(CACHE_KEY(branchId), JSON.stringify(list));
  } catch {
    // sin almacenamiento: solo con conexión
  }
  return list;
}
