import { supabase } from "../../../lib/supabase";
import type { ScaleCatalogItem, ScaleLink, ScaleSaleProfile, ScaleSaleType } from "./profile";

/**
 * Perfil, catálogo y vínculos de la balanza de una sucursal (migración 119).
 * Lo leen todas las cajas; lo cambian solo el dueño o un administrador, por RPC.
 */

export interface ScaleSetup {
  profile: ScaleSaleProfile;
  links: ScaleLink[];
  readAt: string | null;
  repeatWindowMinutes: number;
  /** Interruptor de la sucursal: apagado, Mostrador funciona como antes (no se borra nada). */
  active: boolean;
}

interface ProfileRow {
  scale_key: string;
  brand: string;
  weighed_format: string | null;
  unit_format: string | null;
  total_format: string | null;
  amount_decimals: number;
  generic_codes: number[];
  read_at: string | null;
  repeat_window_minutes: number;
  active: boolean;
}
interface ItemRow {
  code: number;
  name: string;
  sale_type: ScaleSaleType;
  prices: Array<number | string>;
  ean_type: number | null;
  ean_config: string | null;
  link_kind: "product" | "libre" | "none";
  product_id: string | null;
}

const CACHE = (branchId: string) => `patagonia-scale-setup-${branchId}`;

const hasCodes = (p: ProfileRow) => !!(p.weighed_format || p.unit_format || p.total_format);

/**
 * Las balanzas de venta de la sucursal ("artículos + TOTAL"): las que tienen formatos de código guardados. Una
 * sucursal puede tener varias (migración 134); una Kretz registrada sin formatos no cuenta. Apagadas no cuentan.
 * Si no hay conexión, usa la última copia guardada en esta computadora (para seguir cobrando).
 */
export async function loadScaleSetups(branchId: string): Promise<ScaleSetup[]> {
  if (!supabase) return [];
  try {
    const { data: profiles, error } = await supabase.from("scale_profiles").select("scale_key, brand, weighed_format, unit_format, total_format, amount_decimals, generic_codes, read_at, repeat_window_minutes, active").eq("branch_id", branchId);
    if (error) throw error;
    const usable = ((profiles ?? []) as ProfileRow[]).filter((p) => hasCodes(p) && p.active !== false);
    const setups: ScaleSetup[] = [];
    for (const p of usable) setups.push(await setupOf(branchId, p));
    saveCache(branchId, setups);
    return setups;
  } catch (err) {
    // Sin la tabla (42P01) = esta base no tiene la función todavía.
    if (typeof err === "object" && err && "code" in err && (err as { code?: string }).code) return [];
    return loadCache(branchId);
  }
}

/**
 * Una balanza de venta de la sucursal (la de `scaleKey`, o la única que haya), o null. Para Stock y para la
 * sincronización de la Systel; Mostrador usa loadScaleSetups.
 */
export async function loadScaleSetup(branchId: string, opts: { includeInactive?: boolean; scaleKey?: string } = {}): Promise<ScaleSetup | null> {
  if (!supabase) return null;
  try {
    let q = supabase.from("scale_profiles").select("scale_key, brand, weighed_format, unit_format, total_format, amount_decimals, generic_codes, read_at, repeat_window_minutes, active").eq("branch_id", branchId);
    if (opts.scaleKey) q = q.eq("scale_key", opts.scaleKey);
    const { data: profiles, error } = await q;
    if (error) throw error;
    const list = ((profiles ?? []) as ProfileRow[]).filter((p) => opts.scaleKey || hasCodes(p));
    // Sin clave y con varias: no se adivina cuál es.
    if (list.length !== 1) return null;
    const p = list[0];
    if (p.active === false && !opts.includeInactive) return null;
    return await setupOf(branchId, p);
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && (err as { code?: string }).code) return null;
    const cached = loadCache(branchId);
    return cached.find((s) => !opts.scaleKey || s.profile.scaleKey === opts.scaleKey) ?? null;
  }
}

async function setupOf(branchId: string, p: ProfileRow): Promise<ScaleSetup> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  {
    const { data: items, error: e2 } = await supabase.from("scale_catalog_items").select("code, name, sale_type, prices, ean_type, ean_config, link_kind, product_id").eq("branch_id", branchId).eq("scale_key", p.scale_key);
    if (e2) throw e2;
    const rows = (items ?? []) as ItemRow[];
    const setup: ScaleSetup = {
      profile: {
        scaleKey: p.scale_key,
        brand: p.brand,
        weighedFormat: p.weighed_format,
        unitFormat: p.unit_format,
        totalFormat: p.total_format,
        amountDecimals: p.amount_decimals,
        genericCodes: p.generic_codes ?? [],
        catalog: rows.map((r): ScaleCatalogItem => ({ code: r.code, name: r.name, saleType: r.sale_type, prices: (r.prices ?? []).map(Number), eanType: r.ean_type, eanConfig: r.ean_config }))
      },
      links: rows.map((r) => ({ code: r.code, kind: r.link_kind, productId: r.product_id })),
      readAt: p.read_at,
      repeatWindowMinutes: p.repeat_window_minutes,
      active: p.active !== false
    };
    return setup;
  }
}

function saveCache(branchId: string, setups: ScaleSetup[]) {
  try {
    if (setups.length) localStorage.setItem(CACHE(branchId), JSON.stringify(setups));
    else localStorage.removeItem(CACHE(branchId));
  } catch {
    // sin localStorage: sin copia para cuando no haya conexión
  }
}

/** Copia sin conexión. Antes de la 133 se guardaba UNA balanza (objeto); ahora una lista. */
function loadCache(branchId: string): ScaleSetup[] {
  try {
    const raw = localStorage.getItem(CACHE(branchId));
    if (!raw) return [];
    const v = JSON.parse(raw) as ScaleSetup | ScaleSetup[];
    return Array.isArray(v) ? v : [v];
  } catch {
    return [];
  }
}

export async function saveScaleCatalog(branchId: string, profile: Omit<ScaleSaleProfile, "catalog"> & { model?: string }, catalog: ScaleCatalogItem[]): Promise<{ items: number; removed: number }> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("save_scale_catalog", {
    p_branch_id: branchId,
    p_scale_key: profile.scaleKey,
    p_profile: { brand: profile.brand, model: profile.model ?? null, weighed_format: profile.weighedFormat, unit_format: profile.unitFormat, total_format: profile.totalFormat, amount_decimals: profile.amountDecimals, generic_codes: profile.genericCodes },
    p_items: catalog.map((i) => ({ code: i.code, name: i.name, sale_type: i.saleType, prices: i.prices, ean_type: i.eanType, ean_config: i.eanConfig }))
  });
  if (error) throw error;
  return data as { items: number; removed: number };
}

export async function setScaleProfileActive(branchId: string, scaleKey: string, active: boolean): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_scale_profile_active", { p_branch_id: branchId, p_scale_key: scaleKey, p_active: active });
  if (error) throw error;
}

export async function setScaleLinks(branchId: string, scaleKey: string, links: ScaleLink[]): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_scale_links", {
    p_branch_id: branchId,
    p_scale_key: scaleKey,
    p_links: links.map((l) => ({ code: l.code, kind: l.kind, product_id: l.kind === "product" ? l.productId : null }))
  });
  if (error) throw error;
}

/** El servidor avisa que ese papel ya se cobró (create_pos_scale_sale). */
export function repeatedPaperTime(err: unknown): string | null {
  const msg = typeof err === "object" && err && "message" in err ? String((err as { message?: unknown }).message) : "";
  const m = /TICKET_BALANZA_REPETIDO: .* a las (\d{2}:\d{2})/.exec(msg);
  return m ? m[1] : /TICKET_BALANZA_REPETIDO/.test(msg) ? "" : null;
}
