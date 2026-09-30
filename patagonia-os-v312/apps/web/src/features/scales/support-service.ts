import { supabase } from "../../lib/supabase";
import type { DiagnosticReport } from "./diagnostics";
import type { ScaleConnectionRecord } from "./manager";

/**
 * "Enviar a soporte" de la pantalla Balanzas: manda el registro de actividad
 * de esta PC al equipo de Patagonia OS (lo ve el administrador de la
 * plataforma, ver features/admin/AdminScaleReports.tsx). Solo datos
 * técnicos de la balanza -- nada de ventas, saldos ni clientes. Migración 100.
 */
export interface ScaleSupportConnectionInfo {
  displayName: string;
  driverId: string;
  status: string;
  settings: Record<string, unknown>;
  confirmedCapabilities: string[];
  pairedAt: string;
  connectedNow: boolean;
  lastDiagnostic?: { summary: string; steps: { label: string; ok: boolean; detail: string }[] };
}

export function buildSupportConnections(
  connections: ScaleConnectionRecord[],
  liveIds: Set<string>,
  diagnostics: Record<string, DiagnosticReport | undefined>
): ScaleSupportConnectionInfo[] {
  return connections.map((c) => {
    const diagnostic = diagnostics[c.id];
    return {
      displayName: c.displayName,
      driverId: c.driverId,
      status: c.status,
      settings: c.settings,
      confirmedCapabilities: c.confirmedCapabilities,
      pairedAt: c.pairedAt,
      connectedNow: liveIds.has(c.id),
      ...(diagnostic ? { lastDiagnostic: { summary: diagnostic.summary, steps: diagnostic.steps.map((s) => ({ label: s.label, ok: s.ok, detail: s.detail })) } } : {})
    };
  });
}

export async function submitScaleSupportReport(input: {
  note: string;
  logText: string;
  connections: ScaleSupportConnectionInfo[];
  branchId: string | null;
}): Promise<void> {
  if (!supabase) throw new Error("En modo demostración no se puede enviar a soporte.");
  const { error } = await supabase.rpc("submit_scale_support_report", {
    p_note: input.note,
    p_log_text: input.logText,
    p_connections: input.connections,
    p_user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    p_branch_id: input.branchId
  });
  if (error) throw new Error(error.message);
}
