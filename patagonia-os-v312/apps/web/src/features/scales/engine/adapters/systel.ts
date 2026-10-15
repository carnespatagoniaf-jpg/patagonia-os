import { SystelClient, type SystelLink } from "../../../inventory/systel/systel-client";
import { takeSystelBackup, type SystelBackup } from "../../../inventory/systel/systel-backup";
import { discoverSystelLink, loadSavedSystelLink, saveSystelLink } from "../../../inventory/systel/systel-discovery";
import type { SystelLayout } from "../../../inventory/systel/systel-plu";
import { takeProductBackup } from "../../../inventory/systel/systel-product-barcode";
import { saveSystelLabelTemplates, saveSystelPluBarcodes } from "../../../sale/systel-label-format";
import type { ScaleCatalogItem, ScaleLink, ScaleSaleProfile } from "../../sale/profile";
import type { ScaleSetup } from "../../sale/scale-sale-service";
import { canWrite, SCALE_CAPABILITIES, type ScaleModelId } from "../capabilities";
import { FRIENDLY_MESSAGES } from "../friendly";
import type { EngineContext, PendingItem, PreparedSync, ProgressFn, ScaleAdapter, ScaleSession, SyncOutcome } from "../types";
import { planSystelPush, runSystelPush, scaleOnly, type PushItem, type PushProduct } from "./systel-push";

/**
 * Systel (Cuora Max y familia), Patagonia → balanza. Reutiliza, sin cambiarlos:
 * - systel-discovery: encontrar la balanza en el cable (solo lectura);
 * - systel-backup: leer lo que tiene, para armar cada producto sobre lo que ya hay y para la copia previa;
 * - la función 61 (producto completo) con la misma relectura y restauración que se usó en Los gringos el 14/10;
 * - scale-sale-service: Mostrador sabe qué producto es cada código (migración 119), sin que nadie vincule nada:
 *   el número de la balanza ES el código de Patagonia.
 */

/** Firma y formato de la Cuora Max comprobada en una balanza real (Los gringos, 14/10/2026). */
export const SYSTEL_VERIFIED = [{ protocolVersion: "0060", layout: "max60" as SystelLayout }];

export const PRODUCT_BACKUP_KEY = "patagonia-systel-product-backup";

export function systelModelFor(b: Pick<SystelBackup, "signature" | "layout">): ScaleModelId {
  return SYSTEL_VERIFIED.some((v) => v.protocolVersion === b.signature?.protocolVersion && v.layout === b.layout) ? "systel-cuora-max" : "systel-otra";
}

export interface SystelDeps {
  loadSetup: (branchId: string) => Promise<ScaleSetup | null>;
  saveCatalog: (branchId: string, profile: Omit<ScaleSaleProfile, "catalog"> & { model?: string }, catalog: ScaleCatalogItem[]) => Promise<unknown>;
  setLinks: (branchId: string, scaleKey: string, links: ScaleLink[]) => Promise<unknown>;
  setActive: (branchId: string, scaleKey: string, active: boolean) => Promise<unknown>;
  saveLocalBackup: (backup: unknown) => void;
  /** Solo laboratorio y pruebas: permite escribir aunque el envío de productos no esté comprobado en una balanza real. */
  forceWritable?: boolean;
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

interface State {
  backup: SystelBackup;
  products: PushProduct[];
  plan: PushItem[];
  setup: ScaleSetup | null;
}

export class SystelSession implements ScaleSession {
  model: ScaleModelId = "systel-otra";
  label = SCALE_CAPABILITIES["systel-otra"].label;
  private state: State | null = null;

  constructor(
    private readonly link: SystelLink & { close?: () => Promise<void> },
    private readonly address: number,
    private readonly ctx: EngineContext,
    private readonly deps: SystelDeps
  ) {}

  private client(write = false): SystelClient {
    return new SystelClient(this.link, { address: this.address, ...(write ? { writes: { products: true, productBarcode: true } } : {}) });
  }

  private pushProducts(): PushProduct[] {
    return this.ctx.products.filter((p) => p.active ?? true).map((p) => ({ id: p.id, code: p.code, name: p.name, byWeight: p.unit === "kg", price: p.priceRetail }));
  }

  async prepare(onProgress: ProgressFn): Promise<PreparedSync> {
    onProgress("leer", "Leyendo tu balanza…");
    const backup = await takeSystelBackup(this.client(), () => onProgress("leer", "Leyendo tu balanza…"));
    if (!backup.signature && !backup.ping) throw new Error("la balanza no contestó");
    this.model = systelModelFor(backup);
    this.label = SCALE_CAPABILITIES[this.model].label;

    onProgress("comparar", "Comparando con los productos de Patagonia…");
    const setup = this.ctx.online && this.ctx.branchId ? await this.deps.loadSetup(this.ctx.branchId) : null;
    const products = this.pushProducts();
    const layout = backup.layout;
    const plan = layout ? planSystelPush(backup.plus, layout, backup.signature?.priceDecimals ?? 0, products) : [];
    this.state = { backup, products, plan, setup };

    const count = (a: string) => plan.filter((x) => x.action === a).length;
    const writes = count("crear") + count("actualizar");
    const pending: PendingItem[] = plan
      .filter((x) => x.action === "ocupado")
      .map((x) => ({ code: x.number ?? 0, scaleName: x.product.name, byWeight: x.product.byWeight, reason: "ocupado_en_balanza", detail: x.reason, suggestionId: null }));
    const noPrice = plan.filter((x) => x.action === "omitir" && /precio/.test(x.reason)).length;
    const badCode = plan.filter((x) => x.action === "omitir" && !/precio/.test(x.reason)).length;
    const extra = scaleOnly(backup.plus, products).length;
    const notes: string[] = [];
    if (!backup.complete) notes.push("No se pudo leer toda la balanza. Probá de nuevo; si sigue, avisá a soporte.");
    if (noPrice) notes.push(noPrice === 1 ? "1 producto no tiene precio en Patagonia: no se manda hasta que lo tenga." : `${noPrice} productos no tienen precio en Patagonia: no se mandan hasta que lo tengan.`);
    if (badCode) notes.push(`${badCode === 1 ? "1 producto tiene" : `${badCode} productos tienen`} un código que no sirve como número de balanza (tiene que ser un número de hasta 4 cifras, sin repetir).`);
    if (extra) notes.push(extra === 1 ? "La balanza tiene 1 producto que no está en Patagonia: no se toca." : `La balanza tiene ${extra} productos que no están en Patagonia: no se tocan.`);
    const allowed = canWrite(this.model, "sendProducts") || (this.deps.forceWritable === true && this.model === "systel-cuora-max");
    const writable = allowed && !!layout && backup.complete;
    const linked = !!setup?.active && plan.every((x) => x.action !== "sin_cambios" || setup.links.some((l) => l.code === x.number && l.kind === "product" && l.productId === x.product.id));
    const upToDate = writes === 0 && linked;
    return {
      model: this.model,
      label: this.label,
      scaleProducts: products.length,
      ready: count("sin_cambios"),
      writes,
      newLinks: 0,
      pending,
      priceDiffs: 0,
      canWrite: writable,
      upToDate,
      notes,
      ...(!writable && !upToDate
        ? { blocker: allowed ? "No se pudo leer toda la balanza. Tocá \"Conectar balanza\" otra vez." : "Tu balanza está conectada. Para que Patagonia le mande los productos falta habilitarla: lo hace soporte de Patagonia en unos minutos." }
        : this.ctx.canManageLinks === false && !upToDate
          ? { blocker: "Para mandar los productos a la balanza tiene que entrar el dueño o un administrador de Patagonia." }
          : {})
    };
  }

  async sync(prepared: PreparedSync, onProgress: ProgressFn, opts: { allowReplace?: boolean } = {}): Promise<SyncOutcome> {
    const st = this.state;
    if (!st || !st.backup.layout || prepared.blocker || !prepared.canWrite) throw new Error("primero hay que leer la balanza");
    const layout = st.backup.layout;
    const plan = opts.allowReplace ? planSystelPush(st.backup.plus, layout, st.backup.signature?.priceDecimals ?? 0, st.products, { replace: true }) : st.plan;
    const toWrite = plan.filter((x) => x.action === "crear" || x.action === "actualizar" || x.action === "reemplazar");

    let written: { number: number }[] = [];
    if (toWrite.length > 0) {
      onProgress("sincronizar", "Guardando una copia de tu balanza antes de cambiar nada…");
      const writer = this.client(true);
      const existing = toWrite.filter((x) => x.current).map((x) => x.number!);
      if (existing.length) {
        const { backup, missing } = await takeProductBackup(writer, layout, existing);
        if (missing.length) return { ok: false, verified: 0, message: FRIENDLY_MESSAGES.no_contesta, pending: prepared.pending, support: { etapa: "copia", missing } };
        this.deps.saveLocalBackup(backup);
      }
      const r = await runSystelPush(writer, layout, plan, (d, t) => onProgress("sincronizar", "Mandando tus productos a la balanza…", d, t));
      written = r.done;
      if (r.stoppedAt !== null) {
        return { ok: false, verified: r.done.length, message: FRIENDLY_MESSAGES.frenado, pending: prepared.pending, support: { etapa: "envio", stoppedAt: r.stoppedAt, detail: r.detail, restored: r.restored } };
      }
    }

    // Mostrador: cada código de la balanza es el producto de Patagonia con ese código (sin vincular a mano).
    onProgress("verificar", "Dejando Mostrador listo…");
    const sent = plan.filter((x) => x.number !== null && (x.action === "sin_cambios" || written.some((w) => w.number === x.number)));
    const catalog: ScaleCatalogItem[] = sent.map((x) => {
      const ean = { type: 1, config: x.product.byWeight ? "20PPPPCCCCCC" : "21PPPPCCCCCC" };
      return { code: x.number!, name: x.product.name.slice(0, 18), saleType: x.product.byWeight ? "P" : "U", prices: [x.product.price, 0], eanType: ean.type, eanConfig: ean.config };
    });
    const values = st.backup.config?.values ?? {};
    if (this.ctx.online && this.ctx.branchId) {
      await this.deps.saveCatalog(
        this.ctx.branchId,
        { scaleKey: SCALE_KEY, brand: "systel", model: this.label, weighedFormat: values.E_P ?? null, unitFormat: values.E_U ?? null, totalFormat: values.E_S ?? null, amountDecimals: st.backup.signature?.priceDecimals ?? 0, genericCodes: [] },
        catalog
      );
      await this.deps.setLinks(this.ctx.branchId, SCALE_KEY, sent.map((x) => ({ code: x.number!, kind: "product" as const, productId: x.product.id })));
      await this.deps.setActive(this.ctx.branchId, SCALE_KEY, true);
    }
    saveSystelLabelTemplates(values);
    saveSystelPluBarcodes(Object.fromEntries(catalog.map((c) => [String(c.code), { type: c.eanType, config: c.eanConfig, p1: c.prices[0], p2: 0, name: c.name, saleType: c.saleType }])));

    const pending = opts.allowReplace ? [] : prepared.pending;
    return {
      ok: true,
      verified: written.length,
      message: pending.length ? `¡Listo! Tu balanza está conectada y ya podés vender. ${pending.length} productos no se mandaron porque en la balanza ese número es de otro producto.` : "¡Listo! Tu balanza está conectada y ya podés vender.",
      pending
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

