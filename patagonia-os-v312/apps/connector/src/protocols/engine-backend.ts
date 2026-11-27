// Lo que el motor de "Mi balanza" le pide a Patagonia (en la web lo inyecta
// live.ts / systel-live.ts contra Supabase). En el conector lo va a implementar el
// canal con la nube (otro lote); acá está la interfaz y una versión en memoria
// para pruebas y para el banco sin nube.

import type { ScaleConfig } from "../../../web/src/features/sale/scale-barcode";
import type { BranchScaleRef } from "../../../web/src/features/inventory/kretz/branch-scale-guard";
import type { SystelDeps } from "../../../web/src/features/scales/engine/adapters/systel";

type SystelSetup = Awaited<ReturnType<SystelDeps["loadSetup"]>>;
type SystelProfile = Parameters<SystelDeps["saveCatalog"]>[1];
type SystelCatalog = Parameters<SystelDeps["saveCatalog"]>[2];
type SystelLinks = Parameters<SystelDeps["setLinks"]>[2];

export interface SupportReport {
  deviceId: string;
  jobId: string;
  kind: "identify" | "test" | "send";
  ok: boolean;
  message: string;
  /** Datos técnicos (supportInfo de la sesión, diagnóstico). Nunca credenciales. */
  detail: Record<string, unknown>;
}

export interface EngineBackend {
  /** Formato de etiqueta que lee Mostrador en la sucursal (branch_scale_configs). */
  saveBranchScaleConfig(branchId: string, config: ScaleConfig): Promise<void>;
  loadBranchScaleConfig(branchId: string): Promise<ScaleConfig | null>;
  /** Balanzas registradas de la sucursal (scale_profiles): resguardo C1 del formato. */
  listBranchScales(branchId: string): Promise<BranchScaleRef[]>;
  /** Systel: perfil, catálogo y vínculos de Mostrador (migración 119). */
  loadScaleSetup(branchId: string, scaleKey: string): Promise<SystelSetup>;
  saveScaleCatalog(branchId: string, profile: SystelProfile, catalog: SystelCatalog): Promise<unknown>;
  setScaleLinks(branchId: string, scaleKey: string, links: SystelLinks): Promise<unknown>;
  setScaleProfileActive(branchId: string, scaleKey: string, active: boolean): Promise<unknown>;
  /** Reporte técnico a soporte (lo que en la web es "Enviar a soporte"). */
  reportToSupport(report: SupportReport): Promise<void>;
}

/** Versión en memoria: guarda todo lo que el motor manda (pruebas y banco). */
export class MemoryEngineBackend implements EngineBackend {
  readonly branchConfigs = new Map<string, ScaleConfig>();
  readonly branchScales = new Map<string, BranchScaleRef[]>();
  readonly setups = new Map<string, NonNullable<SystelSetup>>();
  readonly catalogs: { branchId: string; profile: SystelProfile; catalog: SystelCatalog }[] = [];
  readonly links = new Map<string, SystelLinks>();
  readonly active = new Map<string, boolean>();
  readonly reports: SupportReport[] = [];

  async saveBranchScaleConfig(branchId: string, config: ScaleConfig): Promise<void> {
    this.branchConfigs.set(branchId, { ...config });
  }

  async loadBranchScaleConfig(branchId: string): Promise<ScaleConfig | null> {
    return this.branchConfigs.get(branchId) ?? null;
  }

  async listBranchScales(branchId: string): Promise<BranchScaleRef[]> {
    return this.branchScales.get(branchId) ?? [];
  }

  async loadScaleSetup(branchId: string, scaleKey: string): Promise<SystelSetup> {
    return this.setups.get(`${branchId}|${scaleKey}`) ?? null;
  }

  async saveScaleCatalog(branchId: string, profile: SystelProfile, catalog: SystelCatalog): Promise<unknown> {
    this.catalogs.push({ branchId, profile, catalog });
    return null;
  }

  async setScaleLinks(branchId: string, scaleKey: string, links: SystelLinks): Promise<unknown> {
    this.links.set(`${branchId}|${scaleKey}`, links);
    return null;
  }

  async setScaleProfileActive(branchId: string, scaleKey: string, active: boolean): Promise<unknown> {
    this.active.set(`${branchId}|${scaleKey}`, active);
    return null;
  }

  async reportToSupport(report: SupportReport): Promise<void> {
    this.reports.push(report);
  }
}
