import { supabase } from "../../lib/supabase";

/**
 * Acceso a las herramientas técnicas de balanza (migración 120). Lo decide la base, no la pantalla:
 * administradores de la plataforma, o una empresa a la que un administrador le abrió el acceso por unas horas
 * (sesión de soporte). Si la base todavía no tiene la migración, o no hay conexión: cerrado.
 */
export async function fetchScaleSupportEnabled(): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { data, error } = await supabase.rpc("scale_support_tools_enabled");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Administrador de la plataforma: abre el acceso de soporte de una empresa por `hours` horas. Devuelve hasta cuándo. */
export async function grantScaleSupportAccess(companyId: string, hours = 2, reason: string | null = null): Promise<string> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("grant_scale_support_access", { p_company_id: companyId, p_hours: hours, p_reason: reason });
  if (error) throw error;
  return data as string;
}

export async function revokeScaleSupportAccess(companyId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("revoke_scale_support_access", { p_company_id: companyId });
  if (error) throw error;
}

/** Empresas con el acceso abierto ahora: { company_id: vence }. Vacío si la base no tiene la migración. */
export async function listScaleSupportAccess(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data, error } = await supabase.rpc("list_scale_support_access");
  if (error || !data) return {};
  return Object.fromEntries((data as { company_id: string; expires_at: string }[]).map((r) => [r.company_id, r.expires_at]));
}
