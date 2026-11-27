// EngineBackend contra la nube: lo que el motor de "Mi balanza" le pide a Patagonia mientras corre un trabajo de
// Scale Connect, por scale-connect-api/engine (migración 227).
//
// La nube decide el alcance: la sucursal es la del trabajo, lo de una balanza solo vale para la balanza del trabajo, y
// las escrituras van por las MISMAS RPC que usa la web (save_branch_scale_config, save_scale_catalog, set_scale_links,
// set_scale_profile_active, submit_scale_support_report) en nombre de quien encoló el trabajo. Acá solo se traducen
// los datos (mismas formas que scale-config-service.ts y scale-sale-service.ts de la web).

import type { EngineBackend, SupportReport } from "../protocols/engine-backend";
import type { JobCloud } from "../cloud/job-executor";
import type { ScaleConfig, ScalePayloadType } from "../../../web/src/features/sale/scale-barcode";
import type { BranchScaleRef } from "../../../web/src/features/inventory/kretz/branch-scale-guard";
import type { SystelDeps } from "../../../web/src/features/scales/engine/adapters/systel";

type SystelSetup = Awaited<ReturnType<SystelDeps["loadSetup"]>>;
type SystelProfile = Parameters<SystelDeps["saveCatalog"]>[1];
type SystelCatalog = Parameters<SystelDeps["saveCatalog"]>[2];
type SystelLinks = Parameters<SystelDeps["setLinks"]>[2];
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);

/** branch_scale_configs (como mapConfig de la web). */
export function parseBranchConfig(raw: unknown): ScaleConfig | null {
  if (!isObj(raw)) return null;
  return {
    prefixLength: num(raw.prefix_length),
    pluLength: num(raw.plu_length),
    weightLength: num(raw.weight_length),
    weightDivisor: num(raw.weight_divisor, 1000),
    totalLength: num(raw.total_length),
    payloadType: (raw.payload_type === "amount" ? "amount" : "weight") as ScalePayloadType,
  };
}

/** Perfil + catálogo + vínculos de una Systel (como setupOf de la web). */
export function parseScaleSetup(raw: unknown): SystelSetup {
  if (!isObj(raw) || !isObj(raw.profile)) return null;
  const p = raw.profile;
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isObj);
  const saleType = (v: unknown) => (v === "U" || v === "E" || v === "C" ? v : "P");
  const linkKind = (v: unknown) => (v === "product" || v === "libre" ? v : "none");
  return {
    profile: {
      scaleKey: str(p.scale_key) ?? "",
      brand: str(p.brand) ?? "",
      weighedFormat: str(p.weighed_format),
      unitFormat: str(p.unit_format),
      totalFormat: str(p.total_format),
      amountDecimals: num(p.amount_decimals),
      genericCodes: Array.isArray(p.generic_codes) ? p.generic_codes.map((c) => num(c)) : [],
      catalog: items.map((r) => ({
        code: num(r.code),
        name: str(r.name) ?? "",
        saleType: saleType(r.sale_type),
        prices: (Array.isArray(r.prices) ? r.prices : []).map((x) => num(x)),
        eanType: r.ean_type === null || r.ean_type === undefined ? null : num(r.ean_type),
        eanConfig: str(r.ean_config),
      })),
    },
    links: items.map((r) => ({ code: num(r.code), kind: linkKind(r.link_kind), productId: str(r.product_id) })),
    readAt: str(p.read_at),
    repeatWindowMinutes: num(p.repeat_window_minutes, 0),
    active: p.active !== false,
  } as NonNullable<SystelSetup>;
}

/** Reporte técnico: nota corta + detalle en JSON, como "Enviar a soporte" de la web. */
export function supportPayload(report: SupportReport): { note: string; log_text: string } {
  const note = `Scale Connect (${report.deviceId}) · ${report.kind}: ${report.message}`.slice(0, 500);
  let log = "";
  try {
    log = JSON.stringify({ trabajo: report.jobId, balanza: report.deviceId, tipo: report.kind, ok: report.ok, mensaje: report.message, detalle: report.detail });
  } catch {
    log = JSON.stringify({ trabajo: report.jobId, balanza: report.deviceId, tipo: report.kind, ok: report.ok, mensaje: report.message });
  }
  return { note, log_text: log.slice(0, 200_000) };
}

export class CloudEngineBackend implements EngineBackend {
  constructor(
    private readonly cloud: JobCloud,
    /** La balanza del trabajo (scale_key). La nube igual la controla. */
    private readonly scaleKey: string,
  ) {}

  async saveBranchScaleConfig(_branchId: string, config: ScaleConfig): Promise<void> {
    const { auraPrefix22: _ignored, ...plain } = config;
    await this.cloud.engine("save_branch_config", { config: plain });
  }

  async loadBranchScaleConfig(): Promise<ScaleConfig | null> {
    const r = await this.cloud.engine("load_branch_config");
    return parseBranchConfig(r.config);
  }

  async listBranchScales(): Promise<BranchScaleRef[]> {
    const r = await this.cloud.engine("list_branch_scales");
    return (Array.isArray(r.scales) ? r.scales : []).filter(isObj).map((s) => ({ key: str(s.key) ?? "", active: s.active !== false }));
  }

  async loadScaleSetup(_branchId: string, scaleKey: string): Promise<SystelSetup> {
    const r = await this.cloud.engine("load_scale_setup", { scale_key: scaleKey || this.scaleKey });
    return parseScaleSetup(r);
  }

  async saveScaleCatalog(_branchId: string, profile: SystelProfile, catalog: SystelCatalog): Promise<unknown> {
    const r = await this.cloud.engine("save_scale_catalog", {
      scale_key: profile.scaleKey || this.scaleKey,
      profile: {
        brand: profile.brand,
        model: (profile as { model?: string }).model ?? null,
        weighed_format: profile.weighedFormat,
        unit_format: profile.unitFormat,
        total_format: profile.totalFormat,
        amount_decimals: profile.amountDecimals,
        generic_codes: profile.genericCodes,
      },
      items: catalog.map((i) => ({ code: i.code, name: i.name, sale_type: i.saleType, prices: i.prices, ean_type: i.eanType, ean_config: i.eanConfig })),
    });
    return r.result ?? null;
  }

  async setScaleLinks(_branchId: string, scaleKey: string, links: SystelLinks): Promise<unknown> {
    const r = await this.cloud.engine("set_scale_links", {
      scale_key: scaleKey || this.scaleKey,
      links: links.map((l) => ({ code: l.code, kind: l.kind, product_id: l.kind === "product" ? l.productId : null })),
    });
    return r.result ?? null;
  }

  async setScaleProfileActive(_branchId: string, scaleKey: string, active: boolean): Promise<unknown> {
    await this.cloud.engine("set_scale_profile_active", { scale_key: scaleKey || this.scaleKey, active });
    return null;
  }

  async reportToSupport(report: SupportReport): Promise<void> {
    await this.cloud.engine("report", supportPayload(report));
  }
}
