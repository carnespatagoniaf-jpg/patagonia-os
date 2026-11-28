import { supabase } from "../../lib/supabase";
import { toError } from "../../lib/supabase-error";
import { mapInstalled, mapRelease, type InstalledVersionStat, type ReleaseChannel, type ScaleConnectRelease } from "./scale-connect-versions";

/**
 * Versiones de Scale Connect (panel de plataforma). Escribe SOLO con las RPC de la 229
 * (set_scale_connect_release, publish_scale_connect_release, set_company_scale_connect_channel) y lee con
 * list_scale_connect_releases (229) + las lecturas de la 231. Todas son solo para administradores de plataforma.
 */

type Raw = Record<string, unknown>;
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);

/** Falta la migración (función inexistente en PostgREST o en Postgres). */
export function isMissingFunction(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "PGRST202" || e?.code === "42883" || /could not find the function/i.test(e?.message ?? "");
}

/** null = la base no tiene la 229 (todavía no hay actualizador). */
export async function fetchReleases(): Promise<ScaleConnectRelease[] | null> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("list_scale_connect_releases");
  if (error) {
    if (isMissingFunction(error)) return null;
    throw toError(error);
  }
  return arr(data).map(mapRelease);
}

/** null = la base no tiene la 231 (se usan los conteos de la 229). */
export async function fetchInstalledVersions(): Promise<InstalledVersionStat[] | null> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("admin_scale_connect_versions");
  if (error) {
    if (isMissingFunction(error)) return null;
    throw toError(error);
  }
  return arr(data).map(mapInstalled);
}

export async function setReleaseRollout(releaseId: string, active: boolean, percent: number | null): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_scale_connect_release", { p_release_id: releaseId, p_active: active, p_rollout_percent: percent });
  if (error) throw toError(error);
}

export async function fetchReleaseManifest(releaseId: string): Promise<Record<string, unknown>> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("admin_scale_connect_release_manifest", { p_release_id: releaseId });
  if (error) {
    if (isMissingFunction(error)) throw new Error("Falta aplicar la migración 231 para pasar versiones a estable desde el panel.");
    throw toError(error);
  }
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/** "Pasar a estable": el MISMO manifiesto firmado, publicado en estable al 0 %. */
export async function publishToStable(manifest: Record<string, unknown>): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("publish_scale_connect_release", { p_manifest: manifest, p_channel: "stable", p_rollout_percent: 0 });
  if (error) throw toError(error);
}

/** null = la base no tiene la 231. */
export async function fetchCompanyChannel(companyId: string): Promise<ReleaseChannel | null> {
  if (!supabase) return "stable";
  const { data, error } = await supabase.rpc("admin_scale_connect_company_channel", { p_company_id: companyId });
  if (error) {
    if (isMissingFunction(error)) return null;
    throw toError(error);
  }
  return data === "pilot" ? "pilot" : "stable";
}

export async function setCompanyChannel(companyId: string, channel: ReleaseChannel): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_company_scale_connect_channel", { p_company_id: companyId, p_channel: channel });
  if (error) throw toError(error);
}
