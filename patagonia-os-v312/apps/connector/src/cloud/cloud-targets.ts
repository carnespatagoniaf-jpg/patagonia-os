// A qué Patagonia se conecta Scale Connect: el sistema real (producción) o el de pruebas (staging).
//
// La dirección sale, en este orden, de PATAGONIA_CLOUD_URL o de "cloud.url" en config.json (ProgramData). El
// instalador escribe config.json con el parámetro /NUBE= (produccion | pruebas | https://…/functions/v1; por omisión,
// producción) usando `scale-connect.exe --set-cloud` (ver setCloudInConfig).
//
// Las direcciones son las de los proyectos de Supabase de Patagonia (no son datos de ningún cliente).

import { readJsonFile, writeFileAtomic } from "../storage/atomic-file";
import { isValidCloudUrl } from "../config/config";

export const PRODUCTION_CLOUD_URL = "https://tayylvhfmoybchutybcz.supabase.co/functions/v1";
export const STAGING_CLOUD_URL = "https://loquhcwsvsbqpinefxcc.supabase.co/functions/v1";

export interface CloudTarget {
  url: string;
  /** "produccion" | "pruebas" | "otra" */
  kind: "produccion" | "pruebas" | "otra";
  /** Lo que se le muestra a la persona en /vincular. */
  label: string;
}

const NAMES: Record<string, string> = {
  produccion: PRODUCTION_CLOUD_URL,
  "producción": PRODUCTION_CLOUD_URL,
  prod: PRODUCTION_CLOUD_URL,
  real: PRODUCTION_CLOUD_URL,
  pruebas: STAGING_CLOUD_URL,
  prueba: STAGING_CLOUD_URL,
  staging: STAGING_CLOUD_URL,
};

/** "/NUBE=pruebas" → la dirección. null = no se entiende (ni nombre conocido ni https válido). */
export function cloudUrlFor(value: string): string | null {
  const v = value.trim();
  const named = NAMES[v.toLowerCase()];
  if (named) return named;
  return isValidCloudUrl(v) ? v.replace(/\/+$/, "") : null;
}

export function describeCloud(url: string): CloudTarget {
  const clean = url.replace(/\/+$/, "");
  if (clean === PRODUCTION_CLOUD_URL) return { url: clean, kind: "produccion", label: "Patagonia System" };
  if (clean === STAGING_CLOUD_URL) return { url: clean, kind: "pruebas", label: "Patagonia System — sistema de PRUEBAS" };
  let host = clean;
  try {
    host = new URL(clean).host;
  } catch {
    // queda la dirección entera
  }
  return { url: clean, kind: "otra", label: `otra dirección (${host})` };
}

export type SetCloudResult = { changed: boolean; url: string; reason: "escrita" | "ya_estaba" | "se_mantiene" };

/**
 * Escribe cloud.url en config.json sin tocar el resto (la configuración del cliente nunca se pisa). Con `ifMissing`
 * (el instalador sin /NUBE=) solo la escribe si todavía no había una: una actualización no cambia de sistema sola.
 * Si config.json está dañado, readJsonFile lo aparta y se arranca de uno vacío.
 */
export async function setCloudInConfig(configFile: string, url: string, options: { ifMissing?: boolean } = {}): Promise<SetCloudResult> {
  if (!isValidCloudUrl(url)) throw new Error(`Dirección de la nube inválida: ${url}`);
  const read = await readJsonFile<Record<string, unknown>>(configFile);
  const current: Record<string, unknown> = read.status === "ok" && read.value && typeof read.value === "object" && !Array.isArray(read.value) ? { ...read.value } : {};
  const cloud = current.cloud && typeof current.cloud === "object" && !Array.isArray(current.cloud) ? { ...(current.cloud as Record<string, unknown>) } : {};
  const existing = typeof cloud.url === "string" && isValidCloudUrl(cloud.url) ? cloud.url.replace(/\/+$/, "") : null;
  if (existing && options.ifMissing) return { changed: false, url: existing, reason: "se_mantiene" };
  if (existing === url) return { changed: false, url, reason: "ya_estaba" };
  cloud.url = url;
  current.cloud = cloud;
  await writeFileAtomic(configFile, `${JSON.stringify(current, null, 2)}\n`);
  return { changed: true, url, reason: "escrita" };
}
