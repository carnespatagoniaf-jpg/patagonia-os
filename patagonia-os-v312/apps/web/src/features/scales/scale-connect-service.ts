import { supabase } from "../../lib/supabase";
import { isMissingFunction } from "./job-log";
import { parseConnectors, parsePairingCode, type PairingCode, type ScaleConnector } from "./scale-connect-logic";

/**
 * Computadoras con Patagonia Scale Connect (migración 226). Solo dueño y administrador (la base lo controla:
 * create_scale_connector_pairing, list/rename/revoke_scale_connector).
 *
 * `null` en listScaleConnectors = no hay base (modo demostración) o todavía no tiene la migración 226: el bloque
 * de Mis balanzas no se muestra.
 */

export async function listScaleConnectors(): Promise<ScaleConnector[] | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("list_scale_connectors");
  if (error) {
    if (isMissingFunction(error)) return null;
    throw new Error(error.message);
  }
  return parseConnectors(data);
}

export async function createPairingCode(branchId: string | null): Promise<PairingCode> {
  if (!supabase) throw new Error("En modo demostración no se pueden vincular computadoras.");
  const { data, error } = await supabase.rpc("create_scale_connector_pairing", { p_branch_id: branchId });
  if (error) throw new Error(error.message);
  const code = parsePairingCode(data);
  if (!code) throw new Error("La respuesta no trajo el código.");
  return code;
}

export async function renameScaleConnector(id: string, name: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.rpc("rename_scale_connector", { p_connector_id: id, p_name: name });
  if (error) throw new Error(error.message);
}

export async function revokeScaleConnector(id: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.rpc("revoke_scale_connector", { p_connector_id: id });
  if (error) throw new Error(error.message);
}
