import { SystelClient, type SystelLink } from "../../../inventory/systel/systel-client";
import { takeSystelBackup, type SystelBackup } from "../../../inventory/systel/systel-backup";
import { discoverSystelLink, loadSavedSystelLink, saveSystelLink } from "../../../inventory/systel/systel-discovery";
import { pluEanSetting, type SystelLayout } from "../../../inventory/systel/systel-plu";
import { rewriteAllProductBarcodes, takeProductBackup, targetCodeFor } from "../../../inventory/systel/systel-product-barcode";
import { saveSystelLabelTemplates, saveSystelPluBarcodes } from "../../../sale/systel-label-format";
import type { ScaleCatalogItem, ScaleLink, ScaleSaleProfile, ScaleSaleType } from "../../sale/profile";
import type { ScaleSetup } from "../../sale/scale-sale-service";
import { canWrite, SCALE_CAPABILITIES, type ScaleModelId } from "../capabilities";
import { FRIENDLY_MESSAGES } from "../friendly";
import { matchScaleCatalog, type MatchResult } from "../matching";
import type { EngineContext, PendingItem, PreparedSync, ProgressFn, ScaleAdapter, ScaleSession, SyncOutcome } from "../types";

/**
 * Systel (Cuora Max y familia). Reutiliza, sin cambiarlos:
 * - systel-discovery: encontrar la balanza en el cable (solo lectura);
 * - systel-backup: leer todos sus productos (solo lectura);
 * - systel-product-barcode: el código propio de cada producto (función 61), con respaldo, relectura y
 *   restauración automática (REAL: Los gringos 14/10, 103 productos);
 * - scale-sale-service: guardar el catálogo y los vínculos en Patagonia (migración 119).
 *
 * Los precios NO se mandan a una Systel (la función 33 no está probada en una balanza real).
 */

/** Firma y formato de la Cuora Max comprobada en una balanza real (Los gringos, 14/10/2026). */
export const SYSTEL_VERIFIED = [{ protocolVersion: "0060", layout: "max60" as SystelLayout }];

export const PRODUCT_BACKUP_KEY = "patagonia-systel-product-backup";

export function systelModelFor(b: Pick<SystelBackup, "signature" | "layout">): ScaleModelId {
  return SYSTEL_VERIFIED.some((v) => v.protocolVersion === b.signature?.protocolVersion && v.layout === b.layout) ? "systel-cuora-max" : "systel-otra";
}

const isWeighed = (t: string) => t === "P" || t === "C";

export interface SystelCatalogEntry {
  number: number;
  item: ScaleCatalogItem;
  raw: string;
}

export function systelCatalog(b: SystelBackup): SystelCatalogEntry[] {
  const dec = b.signature?.priceDecimals === 2 ? 100 : 1;
  return b.plus.map((plu) => {
    const ean = pluEanSetting(plu.raw);
    return {
      number: plu.number,
      raw: plu.raw,
      item: { code: plu.code, name: plu.name.trim(), saleType: plu.saleType as ScaleSaleType, prices: plu.prices.slice(0, 2).map((x) => x / dec), eanType: ean.type, eanConfig: ean.config }
    };
  });
}

/** Productos a los que falta su código propio en el ticket (lo único que se escribe en una Systel). */
export function barcodeWork(entries: SystelCatalogEntry[]): { number: number; saleType: string }[] {
  return entries
    .filter((e) => {
      const target = targetCodeFor(e.item.saleType);
      return !!target && !(e.item.eanType === 1 && e.item.eanConfig === target);
    })
    .map((e) => ({ number: e.number, saleType: e.item.saleType }));
}

export interface SystelDeps {
  loadSetup: (branchId: string) => Promise<ScaleSetup | null>;
  saveCatalog: (branchId: string, profile: Omit<ScaleSaleProfile, "catalog"> & { model?: string }, catalog: ScaleCatalogItem[]) => Promise<unknown>;
  setLinks: (branchId: string, scaleKey: string, links: ScaleLink[]) => Promise<unknown>;
  setActive: (branchId: string, scaleKey: string, active: boolean) => Promise<unknown>;
  saveLocalBackup: (backup: unknown) => void;
}

/** Copia local del respaldo de productos (la misma que usa "Restaurar desde el respaldo" en el panel de soporte). */
export function saveProductBackupLocally(backup: unknown): void {
  try {
    localStorage.setItem(PRODUCT_BACKUP_KEY, JSON.stringify(backup));
  } catch {
    // sin localStorage: el respaldo igual va en el resultado para soporte
  }
}

const SCALE_KEY = "systel";

interface Prepared {
  backup: SystelBackup;
  entries: SystelCatalogEntry[];
  match: MatchResult;
  setup: ScaleSetup | null;
  work: { number: number; saleType: string }[];
}

export class SystelSession implements ScaleSession {
  model: ScaleModelId = "systel-otra";
  label = SCALE_CAPABILITIES["systel-otra"].label;
  private state: Prepared | null = null;

  constructor(
    private readonly link: SystelLink & { close?: () => Promise<void> },
    private readonly address: number,
    private readonly ctx: EngineContext,
    private readonly deps: SystelDeps
  ) {}

  private client(write = false): SystelClient {
    return new SystelClient(this.link, { address: this.address, ...(write ? { writes: { productBarcode: true } } : {}) });
  }

  async prepare(onProgress: ProgressFn): Promise<PreparedSync> {
    onProgress("leer", "Leyendo los productos de tu balanza…");
    const backup = await takeSystelBackup(this.client(), (t) => onProgress("leer", t.replace(/…$/, "") + "…"));
    if (!backup.signature && !backup.ping) throw new Error("la balanza no contestó");
    this.model = systelModelFor(backup);
    this.label = SCALE_CAPABILITIES[this.model].label;
    const entries = systelCatalog(backup);

    onProgress("comparar", "Comparando con los productos de Patagonia…");
    const setup = this.ctx.online && this.ctx.branchId ? await this.deps.loadSetup(this.ctx.branchId) : null;
    const usable = entries.filter((e) => e.item.saleType === "P" || e.item.saleType === "U" || e.item.saleType === "C");
    const match = matchScaleCatalog(
      usable.map((e) => ({ code: e.item.code, name: e.item.name, byWeight: isWeighed(e.item.saleType), price: e.item.prices[0] })),
      this.ctx.products,
      setup?.links ?? []
    );
    const writable = canWrite(this.model, "itemBarcodes") && backup.layout !== null;
    const work = writable ? barcodeWork(usable) : [];
    this.state = { backup, entries: usable, match, setup, work };

    const pending: PendingItem[] = match.decisions.flatMap((d) => {
      if (d.kind !== "pending") return [];
      const e = usable.find((x) => x.item.code === d.code)!;
      return [{ code: d.code, scaleName: e.item.name, byWeight: isWeighed(e.item.saleType), reason: d.reason, detail: d.detail, suggestionId: d.suggestionId }];
    });
    const savedSame = !!setup && setup.active && setup.profile.catalog.length === usable.length && usable.every((e) => setup.profile.catalog.some((c) => c.code === e.item.code && c.eanConfig === e.item.eanConfig && c.eanType === e.item.eanType));
    const notes: string[] = [];
    if (!backup.complete) notes.push("No se pudieron leer todos los productos de la balanza. Probá de nuevo; si sigue, avisá a soporte.");
    if (!writable) notes.push("Esta balanza se puede leer, pero todavía no está habilitada para que Patagonia le configure los códigos. Soporte te ayuda a habilitarla.");
    notes.push("Los precios se siguen cargando en la balanza.");
    return {
      model: this.model,
      label: this.label,
      scaleProducts: usable.length,
      ready: match.kept + match.auto,
      writes: work.length,
      newLinks: match.auto,
      pending,
      priceDiffs: match.priceDiffs,
      canWrite: writable,
      upToDate: work.length === 0 && match.auto === 0 && savedSame,
      notes,
      ...(this.ctx.canManageLinks === false && !(work.length === 0 && match.auto === 0 && savedSame) ? { blocker: "Para configurar la balanza tiene que entrar el dueño o un administrador de Patagonia." } : {})
    };
  }

  async sync(prepared: PreparedSync, onProgress: ProgressFn): Promise<SyncOutcome> {
    const st = this.state;
    if (!st) throw new Error("primero hay que leer la balanza");
    const layout = st.backup.layout;
    const after = new Map<number, string>();
    let verified = 0;

    // 1. Escritura (solo lo comprobado): código propio de cada producto, con respaldo previo y relectura de cada uno.
    if (st.work.length > 0 && prepared.canWrite && layout) {
      onProgress("sincronizar", "Guardando una copia de tus productos antes de cambiar nada…");
      const writer = this.client(true);
      const { backup, missing } = await takeProductBackup(writer, layout, st.work.map((w) => w.number));
      if (missing.length > 0) {
        return { ok: false, verified: 0, message: FRIENDLY_MESSAGES.no_contesta, pending: prepared.pending, support: { etapa: "respaldo", missing } };
      }
      this.deps.saveLocalBackup(backup);
      const r = await rewriteAllProductBarcodes(writer, layout, st.work, {
        mode: "ascii",
        onProgress: (t) => {
          const m = /Producto (\d+) de (\d+)/.exec(t);
          onProgress("sincronizar", "Configurando tu balanza…", m ? Number(m[1]) : undefined, m ? Number(m[2]) : undefined);
        }
      });
      for (const x of r.results) if (x.after) after.set(x.number, x.after);
      verified = r.results.filter((x) => x.ok).length;
      if (r.stoppedAt !== null) {
        return { ok: false, verified, message: FRIENDLY_MESSAGES.frenado, pending: prepared.pending, support: { etapa: "escritura", stoppedAt: r.stoppedAt, results: r.results.map((x) => ({ n: x.number, v: x.verdict, d: x.detail })) } };
      }
    }

    // 2. Lo leído (con los códigos nuevos, ya releídos) queda guardado en Patagonia, con los vínculos.
    const catalog = st.entries.map((e) => {
      const raw = after.get(e.number);
      if (!raw) return e.item;
      const ean = pluEanSetting(raw);
      return { ...e.item, eanType: ean.type, eanConfig: ean.config };
    });
    const values = st.backup.config?.values ?? {};
    onProgress("verificar", "Guardando en Patagonia…");
    if (this.ctx.online && this.ctx.branchId) {
      await this.deps.saveCatalog(
        this.ctx.branchId,
        { scaleKey: SCALE_KEY, brand: "systel", model: this.label, weighedFormat: values.E_P ?? null, unitFormat: values.E_U ?? null, totalFormat: values.E_S ?? null, amountDecimals: st.backup.signature?.priceDecimals ?? 0, genericCodes: [] },
        catalog
      );
      const links: ScaleLink[] = st.match.decisions.flatMap((d) => (d.kind === "auto" ? [{ code: d.code, kind: "product" as const, productId: d.productId }] : []));
      if (links.length) await this.deps.setLinks(this.ctx.branchId, SCALE_KEY, links);
      await this.deps.setActive(this.ctx.branchId, SCALE_KEY, true);
    }
    // Compatibilidad con la lectura de tickets que ya usa Mostrador en esta computadora.
    saveSystelLabelTemplates(values);
    saveSystelPluBarcodes(Object.fromEntries(catalog.map((c) => [String(c.code), { type: c.eanType, config: c.eanConfig, p1: c.prices[0], p2: c.prices[1], name: c.name, saleType: c.saleType }])));

    return {
      ok: true,
      verified,
      message: prepared.pending.length ? `¡Listo! Tu balanza está conectada y ya podés vender. Quedan ${prepared.pending.length} productos para revisar.` : "¡Listo! Tu balanza está conectada y ya podés vender.",
      pending: prepared.pending
    };
  }

  async close(): Promise<void> {
    await this.link.close?.();
  }

  supportInfo(): Record<string, unknown> {
    const b = this.state?.backup;
    return { marca: "systel", modelo: this.model, direccion: this.address, firma: b?.signature ?? null, formato: b?.layout ?? null, productos: b?.plus.length ?? 0, completo: b?.complete ?? null, detalle: b?.detail ?? null };
  }
}

/** El adaptador, con la base que le pase quien lo arma (systel-live.ts en la app; dobles en las pruebas). */
export function makeSystelAdapter(deps: SystelDeps): ScaleAdapter {
  return {
    family: "systel",
    async identify(port: SerialPort, ctx: EngineContext, onProgress: ProgressFn): Promise<ScaleSession | null> {
      onProgress("buscar", "Buscando tu balanza…");
      const found = await discoverSystelLink(port, [], () => onProgress("buscar", "Buscando tu balanza…"), loadSavedSystelLink(), 350);
      if (!found) return null;
      saveSystelLink({ settings: found.settings, address: found.address });
      return new SystelSession(found.link, found.address, ctx, deps);
    }
  };
}
