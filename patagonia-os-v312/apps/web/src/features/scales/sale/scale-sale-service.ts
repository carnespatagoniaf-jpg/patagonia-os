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

/**
 * La balanza de venta de la sucursal, o null si no tiene (o la base todavía no tiene la migración 119).
 * Si no hay conexión, usa la última copia guardada en esta computadora (para seguir cobrando).
 */
export async function loadScaleSetup(branchId: string, opts: { includeInactive?: boolean } = {}): Promise<ScaleSetup | null> {
  if (!supabase) return null;
  try {
    const { data: profiles, error } = await supabase.from("scale_profiles").select("scale_key, brand, weighed_format, unit_format, total_format, amount_decimals, generic_codes, read_at, repeat_window_minutes, active").eq("branch_id", branchId).limit(2);
    if (error) throw error;
    if (!profiles || profiles.length === 0) {
      saveCache(branchId, null);
      return null;
    }
    // Una sola balanza de venta por sucursal en esta versión: con dos, no se adivina cuál es.
    if (profiles.length > 1) return null;
    const p = profiles[0] as ProfileRow;
    // Apagada: Mostrador no la usa (la pantalla de Stock sí la ve, para volver a encenderla).
    if (p.active === false && !opts.includeInactive) {
      saveCache(branchId, null);
      return null;
    }
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
    if (setup.active) saveCache(branchId, setup);
    return setup;
  } catch (err) {
    // Sin la tabla (42P01) = esta base no tiene la función todavía.
    if (typeof err === "object" && err && "code" in err && (err as { code?: string }).code) return null;
    return loadCache(branchId);
  }
}

function saveCache(branchId: string, setup: ScaleSetup | null) {
  try {
    if (setup) localStorage.setItem(CACHE(branchId), JSON.stringify(setup));
    else localStorage.removeItem(CACHE(branchId));
  } catch {
    // sin localStorage: sin copia para cuando no haya conexión
  }
}

function loadCache(branchId: string): ScaleSetup | null {
  try {
    const raw = localStorage.getItem(CACHE(branchId));
    return raw ? (JSON.parse(raw) as ScaleSetup) : null;
  } catch {
    return null;
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
