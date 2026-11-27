import { supabase } from "../../lib/supabase";
import { toError } from "../../lib/supabase-error";
import { scaleTrafficLight, type Light } from "./scale-center";

/**
 * Centro de diagnóstico de balanzas (migración 230): solo lectura y solo administradores de la plataforma.
 * Lo único que escribe la pantalla es "Marcar resuelto" (set_scale_support_report_resolved, migración 100,
 * en admin-service.ts).
 */

export interface ScaleOverviewRow {
  companyId: string;
  companyName: string;
  companyActive: boolean;
  plan: string | null;
  balanzasV2: boolean;
  branchId: string | null;
  branchName: string | null;
  scalesActive: number;
  scalesByBrand: Record<string, number>;
  duplicateGroups: number;
  connectorsActive: number;
  connectorsOnline: number;
  connectorsStale: number;
  connectorVersionMin: string | null;
  connectorVersionMax: string | null;
  connectorLastSeen: string | null;
  lastJobAt: string | null;
  lastJobStatus: string | null;
  lastJobConfirmed: number | null;
  lastJobRequested: number | null;
  jobsFailed7d: number;
  jobsStuck: number;
  reportsOpen: number;
  lastReportAt: string | null;
  lastOpenReportStage: string | null;
  lastOpenReportMessage: string | null;
  light: Light;
  lightReason: string;
}

export interface ScaleDetailScale {
  branchName: string | null;
  scaleKey: string;
  name: string | null;
  brand: string;
  model: string | null;
  family: string | null;
  identity: Record<string, unknown>;
  labelSpec: { prefixes?: { weighed?: string | null; unit?: string | null; total?: string | null }; writer?: { kind?: string; code?: string; weighed?: string; unit?: string } | null } | null;
  weighedFormat: string | null;
  status: string;
  active: boolean;
  install: Record<string, unknown>;
  connectorName: string | null;
  connectorDevice: Record<string, unknown> | null;
  lastUsedAt: string | null;
}

export interface ScaleDetailConnector {
  id: string;
  name: string;
  branchName: string | null;
  version: string | null;
  status: string;
  lastSeenAt: string | null;
  online: boolean;
  seenScales: number;
  revokedAt: string | null;
}

export interface ScaleDetailJob {
  id: string;
  branchName: string | null;
  scaleKey: string;
  scaleName: string | null;
  kind: string;
  source: string;
  status: string;
  requested: number;
  confirmed: number;
  failed: number;
  skipped: number;
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  appVersion: string | null;
  connectorName: string | null;
}

export interface ScaleDetailFailedProduct {
  product: string;
  plu: string | null;
  reason: string;
  times: number;
  lastAt: string;
}

export interface ScaleDetailReport {
  id: string;
  branchName: string | null;
  userName: string | null;
  createdAt: string;
  resolvedAt: string | null;
  note: string | null;
  stage: string | null;
  message: string | null;
  technical: string | null;
  appVersion: string | null;
  logLength: number;
}

export interface ScaleCompanyDetail {
  company: { id: string; name: string; active: boolean; plan: string | null; balanzasV2: boolean };
  scales: ScaleDetailScale[];
  connectors: ScaleDetailConnector[];
  jobs: ScaleDetailJob[];
  failedProducts: ScaleDetailFailedProduct[];
  reports: ScaleDetailReport[];
  ambiguitiesSupported: boolean;
  ambiguities: unknown[];
}

export interface ScaleReportLog {
  id: string;
  companyName: string;
  branchName: string | null;
  createdAt: string;
  resolvedAt: string | null;
  note: string | null;
  userAgent: string | null;
  connections: unknown;
  logText: string;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);

/** La base todavía no tiene la migración 230 (función inexistente). */
export function isMissingScaleCenter(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "PGRST202" || e?.code === "42883" || /admin_scale_overview|could not find the function/i.test(e?.message ?? "");
}

export function mapOverviewRow(r: Raw): ScaleOverviewRow {
  const base = {
    companyId: String(r.company_id),
    companyName: String(r.company_name ?? ""),
    companyActive: r.company_active !== false,
    plan: str(r.plan),
    balanzasV2: r.balanzas_v2 === true,
    branchId: str(r.branch_id),
    branchName: str(r.branch_name),
    scalesActive: num(r.scales_active),
    scalesByBrand: Object.fromEntries(Object.entries(obj(r.scales_by_brand)).map(([k, v]) => [k, num(v)])),
    duplicateGroups: num(r.duplicate_groups),
    connectorsActive: num(r.connectors_active),
    connectorsOnline: num(r.connectors_online),
    connectorsStale: num(r.connectors_stale),
    connectorVersionMin: str(r.connector_version_min),
    connectorVersionMax: str(r.connector_version_max),
    connectorLastSeen: str(r.connector_last_seen),
    lastJobAt: str(r.last_job_at),
    lastJobStatus: str(r.last_job_status),
    lastJobConfirmed: numOrNull(r.last_job_confirmed),
    lastJobRequested: numOrNull(r.last_job_requested),
    jobsFailed7d: num(r.jobs_failed_7d),
    jobsStuck: num(r.jobs_stuck),
    reportsOpen: num(r.reports_open),
    lastReportAt: str(r.last_report_at),
    lastOpenReportStage: str(r.last_open_report_stage),
    lastOpenReportMessage: str(r.last_open_report_message)
  };
  // El semáforo se recalcula con la misma regla que la base (scale-center.ts), así la web y el SQL nunca discrepan
  // por una versión vieja de una de las dos.
  const verdict = scaleTrafficLight(base);
  return { ...base, light: verdict.light, lightReason: verdict.reason };
}

export function mapCompanyDetail(d: Raw): ScaleCompanyDetail {
  const c = obj(d.company);
  return {
    company: { id: String(c.id ?? ""), name: String(c.name ?? ""), active: c.active !== false, plan: str(c.plan), balanzasV2: c.balanzas_v2 === true },
    scales: arr(d.scales).map((s) => ({
      branchName: str(s.branch_name),
      scaleKey: String(s.scale_key ?? ""),
      name: str(s.name),
      brand: String(s.brand ?? ""),
      model: str(s.model),
      family: str(s.family),
      identity: obj(s.identity),
      labelSpec: s.label_spec && typeof s.label_spec === "object" ? (s.label_spec as ScaleDetailScale["labelSpec"]) : null,
      weighedFormat: str(s.weighed_format),
      status: String(s.status ?? "active"),
      active: s.active !== false,
      install: obj(s.install),
      connectorName: str(s.connector_name),
      connectorDevice: s.connector_device && typeof s.connector_device === "object" ? obj(s.connector_device) : null,
      lastUsedAt: str(s.last_used_at)
    })),
    connectors: arr(d.connectors).map((x) => ({
      id: String(x.id ?? ""),
      name: String(x.name ?? ""),
      branchName: str(x.branch_name),
      version: str(x.version),
      status: String(x.status ?? ""),
      lastSeenAt: str(x.last_seen_at),
      online: x.online === true,
      seenScales: num(x.seen_scales),
      revokedAt: str(x.revoked_at)
    })),
    jobs: arr(d.jobs).map((j) => ({
      id: String(j.id ?? ""),
      branchName: str(j.branch_name),
      scaleKey: String(j.scale_key ?? ""),
      scaleName: str(j.scale_name),
      kind: String(j.kind ?? ""),
      source: String(j.source ?? ""),
      status: String(j.status ?? ""),
      requested: num(j.requested_count),
      confirmed: num(j.confirmed_count),
      failed: num(j.failed_count),
      skipped: num(j.skipped_count),
      startedAt: String(j.started_at ?? ""),
      finishedAt: str(j.finished_at),
      errorCode: str(j.error_code),
      appVersion: str(j.app_version),
      connectorName: str(j.connector_name)
    })),
    failedProducts: arr(d.failed_products).map((f) => ({
      product: String(f.product ?? ""),
      plu: str(f.plu),
      reason: String(f.reason ?? ""),
      times: num(f.times),
      lastAt: String(f.last_at ?? "")
    })),
    reports: arr(d.reports).map((r) => ({
      id: String(r.id ?? ""),
      branchName: str(r.branch_name),
      userName: str(r.user_name),
      createdAt: String(r.created_at ?? ""),
      resolvedAt: str(r.resolved_at),
      note: str(r.note),
      stage: str(r.etapa),
      message: str(r.mensaje),
      technical: str(r.tecnico),
      appVersion: str(r.app_version),
      logLength: num(r.log_length)
    })),
    ambiguitiesSupported: d.ambiguities_supported === true,
    ambiguities: Array.isArray(d.ambiguities) ? d.ambiguities : []
  };
}

export async function fetchScaleOverview(): Promise<ScaleOverviewRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("admin_scale_overview");
  if (error) throw isMissingScaleCenter(error) ? Object.assign(new Error("missing"), { missing: true }) : toError(error);
  return arr(data).map(mapOverviewRow);
}

export async function fetchScaleCompanyDetail(companyId: string): Promise<ScaleCompanyDetail> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("admin_scale_company_detail", { p_company_id: companyId });
  if (error) throw toError(error);
  return mapCompanyDetail(obj(data));
}

export async function fetchScaleReportLog(reportId: string): Promise<ScaleReportLog> {
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("admin_scale_report_log", { p_report_id: reportId });
  if (error) throw toError(error);
  const d = obj(data);
  return {
    id: String(d.id ?? reportId),
    companyName: String(d.company_name ?? ""),
    branchName: str(d.branch_name),
    createdAt: String(d.created_at ?? ""),
    resolvedAt: str(d.resolved_at),
    note: str(d.note),
    userAgent: str(d.user_agent),
    connections: d.connections ?? [],
    logText: String(d.log_text ?? "")
  };
}
