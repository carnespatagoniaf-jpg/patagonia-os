import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { toError } from "../../lib/supabase-error";
import type { BoxLabelFormat } from "./box-label";

// Formatos de etiquetas de cajas de la empresa (migración 198). Se guardan también en esta PC para que Mostrador
// lea cajas sin conexión.

const CACHE_KEY = "patagonia-box-label-formats";

interface Row {
  id: string;
  name: string;
  total_length: number;
  product_start: number;
  product_length: number;
  fixed_start: number;
  fixed_text: string;
  weight_start: number;
  weight_length: number;
  weight_divisor: number;
  product_map?: Record<string, string> | null;
}

const fromRow = (r: Row): BoxLabelFormat => ({
  id: r.id,
  name: r.name,
  totalLength: r.total_length,
  productStart: r.product_start,
  productLength: r.product_length,
  fixedStart: r.fixed_start,
  fixedText: r.fixed_text ?? "",
  weightStart: r.weight_start,
  weightLength: r.weight_length,
  weightDivisor: Number(r.weight_divisor),
  productMap: r.product_map ?? {}
});

function cached(): BoxLabelFormat[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as BoxLabelFormat[]) : [];
  } catch {
    return [];
  }
}

export async function listBoxLabelFormats(): Promise<BoxLabelFormat[]> {
  if (!supabase) return cached();
  const COLUMNS = "id,name,total_length,product_start,product_length,fixed_start,fixed_text,weight_start,weight_length,weight_divisor";
  let { data, error }: { data: unknown[] | null; error: { code?: string; message: string } | null } = await supabase
    .from("box_label_formats")
    .select(`${COLUMNS},product_map`)
    .order("created_at");
  // Sin la migración 200 todavía: sin productos asociados (las cajas se buscan por código, como en 198).
  if (error && (error.code === "42703" || error.code === "PGRST204")) {
    ({ data, error } = await supabase.from("box_label_formats").select(COLUMNS).order("created_at"));
  }
  if (error) {
    // Sin la migración todavía: ninguna caja (Mostrador sigue como siempre).
    if (error.code === "42P01" || error.code === "PGRST205") return [];
    throw toError(error);
  }
  const formats = ((data ?? []) as Row[]).map(fromRow);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(formats));
  } catch {
    // sin almacenamiento: se usa igual
  }
  return formats;
}

export async function saveBoxLabelFormat(format: Omit<BoxLabelFormat, "id"> & { id?: string | null }): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("save_box_label_format", {
    p_id: format.id ?? null,
    p_name: format.name,
    p_total_length: format.totalLength,
    p_product_start: format.productStart,
    p_product_length: format.productLength,
    p_fixed_start: format.fixedStart,
    p_fixed_text: format.fixedText,
    p_weight_start: format.weightStart,
    p_weight_length: format.weightLength,
    p_weight_divisor: format.weightDivisor
  });
  if (error) throw toError(error);
  return data as string;
}

/** Asociar un número de caja a un producto (productId null = soltarlo). Migración 200. */
export async function setBoxLabelProduct(formatId: string, digits: string, productId: string | null): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_box_label_product", { p_format_id: formatId, p_digits: digits, p_product_id: productId });
  if (error) throw toError(error);
}

export async function deleteBoxLabelFormat(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("delete_box_label_format", { p_id: id });
  if (error) throw toError(error);
}

/** Los formatos de la empresa: primero los guardados en esta PC, después los de la base. Sin la pantalla a pedido
 * 'etiquetas_caja' (enabled false) no hay ninguno: Mostrador sigue como siempre. */
export function useBoxLabelFormats(enabled = true) {
  const [formats, setFormats] = useState<BoxLabelFormat[]>(() => (enabled ? cached() : []));
  const reload = useCallback(async () => {
    if (!enabled) {
      setFormats([]);
      return;
    }
    try {
      setFormats(await listBoxLabelFormats());
    } catch {
      // sin conexión: quedan los guardados en esta PC
    }
  }, [enabled]);
  useEffect(() => {
    void reload();
    const onChange = () => void reload();
    window.addEventListener("patagonia-box-formats-changed", onChange);
    return () => window.removeEventListener("patagonia-box-formats-changed", onChange);
  }, [reload]);
  return { formats, reload };
}

export function notifyBoxFormatsChanged() {
  window.dispatchEvent(new Event("patagonia-box-formats-changed"));
}
