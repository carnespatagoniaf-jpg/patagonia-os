import { supabase } from "./supabase";

/** Anota que la empresa usó una pantalla (migración 130, solo el nombre de la
 * pantalla). Una vez por pantalla por día en este navegador; nunca tira error
 * ni frena nada si falla (por ejemplo, base sin la migración). */
const sent = new Set<string>();

export function trackPageVisit(page: string) {
  if (!supabase) return;
  const key = `${new Date().toDateString()}|${page}`;
  if (sent.has(key)) return;
  sent.add(key);
  void supabase.rpc("track_page_visit", { p_page: page }).then(
    () => undefined,
    () => undefined
  );
}
