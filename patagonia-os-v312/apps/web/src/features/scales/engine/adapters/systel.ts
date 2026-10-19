import { SystelClient, type SystelLink } from "../../../inventory/systel/systel-client";
import { takeSystelBackup, type SystelBackup } from "../../../inventory/systel/systel-backup";
import type { SystelExchangeLog } from "../../../inventory/systel/systel-client";
import { discoverSystelLink, loadSavedSystelLink, saveSystelLink, type SystelFoundLink } from "../../../inventory/systel/systel-discovery";
import type { SystelLinkEvent } from "../../../inventory/systel/systel-serial";
import type { SystelLayout } from "../../../inventory/systel/systel-plu";
import { takeProductBackup } from "../../../inventory/systel/systel-product-barcode";
import { saveSystelLabelTemplates, saveSystelPluBarcodes } from "../../../sale/systel-label-format";
import type { ScaleCatalogItem, ScaleLink, ScaleSaleProfile } from "../../sale/profile";
import type { ScaleSetup } from "../../sale/scale-sale-service";
import { canWrite, SCALE_CAPABILITIES, type ScaleModelId } from "../capabilities";
import { FRIENDLY_MESSAGES, FriendlyError } from "../friendly";
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
  loadSetup: (branchId: string, scaleKey: string) => Promise<ScaleSetup | null>;
  saveCatalog: (branchId: string, profile: Omit<ScaleSaleProfile, "catalog"> & { model?: string }, catalog: ScaleCatalogItem[]) => Promise<unknown>;
  setLinks: (branchId: string, scaleKey: string, links: ScaleLink[]) => Promise<unknown>;
  setActive: (branchId: string, scaleKey: string, active: boolean) => Promise<unknown>;
  saveLocalBackup: (backup: unknown) => void;
  /** Solo laboratorio y pruebas: permite escribir aunque el envío de productos no esté comprobado en una balanza real. */
  forceWritable?: boolean;
  /** Guardar con la conexión de esta computadora las señales y el número con los que atendió la balanza. */
  onConnectionHints?: (hints: { lines?: { dtr: boolean; rts: boolean }; requestAddress?: number }) => void;
}

/** Copia local del respaldo de productos (la misma que usa "Restaurar desde el respaldo" en el panel de soporte). */
export function saveProductBackupLocally(backup: unknown): void {
  try {
    localStorage.setItem(PRODUCT_BACKUP_KEY, JSON.stringify(backup));
  } catch {
    // sin localStorage: el respaldo igual va en el resultado para soporte
  }
}

/** Clave de la balanza de antes de la migración 134 (una sola Systel por sucursal). */
export const LEGACY_SYSTEL_KEY = "systel";

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
  /** Todo lo que se le mandó y contestó en esta sesión (para soporte). */
  private readonly log: SystelExchangeLog[] = [];
  /** La última lectura, aunque haya fallado (antes se perdía y el reporte decía solo "no contestó"). */
  private lastBackup: SystelBackup | null = null;

  /** Número de la balanza (el que contestó en la búsqueda): la identifica. */
  private readonly number: number;
  /** A qué número se le hacen los pedidos: el suyo, el 1 o el general (0), el primero que atienda (ver pickAddress). */
  private address: number;
  /** Cómo quedó elegido el número de los pedidos (para soporte). */
  private addressNote = "";
  /** Señales con las que atendió, si no fueron las de siempre (DTR y RTS encendidas). */
  private lines: { dtr: boolean; rts: boolean } | null = null;

  constructor(
    private readonly link: SystelLink & { close?: () => Promise<void> },
    address: number,
    private readonly ctx: EngineContext,
    private readonly deps: SystelDeps,
    known: { lines?: { dtr: boolean; rts: boolean }; requestAddress?: number } = {}
  ) {
    this.number = address;
    this.address = known.requestAddress ?? address;
    this.lines = known.lines ?? null;
  }

  private get scaleKey(): string {
    return this.ctx.scaleKey ?? LEGACY_SYSTEL_KEY;
  }

  private client(write = false): SystelClient {
    return new SystelClient(this.link, { address: this.address, log: this.log, ...(write ? { writes: { products: true, productBarcode: true } } : {}) });
  }

  private pushProducts(): PushProduct[] {
    return this.ctx.products.filter((p) => p.active ?? true).map((p) => ({ id: p.id, code: p.code, name: p.name, byWeight: p.unit === "kg", price: p.priceRetail }));
  }

  /**
   * A qué número le hace caso para los pedidos. Real: la Cuora Max de Los gringos (N.º 20) atendió todo pedido hecho
   * al 1 (sesiones buenas del 14/10, "dirección 1"), y una balanza NUEVA del mismo cliente (19/10) contestó la búsqueda
   * como N.º 20 y después no atendió la firma ni el ping hechos a su número. El documento no fija cuál debe usarse
   * (V6.0 págs. 2-3: "Unicast", 0 = "Broadcast"). En vez de suponer, se pide la firma (función 2, solo lectura) a su
   * número, al 1 y al general, y se usa el primero que la entrega. Con el general (0) se acepta UNA sola respuesta por
   * pedido (SystelClient descarta las ambiguas), así que no se confunde con otra balanza en el mismo cable.
   */
  private async pickAddress(onProgress: ProgressFn): Promise<boolean> {
    for (const a of [...new Set([this.address, this.number, 1, 0])]) {
      onProgress("leer", "Leyendo tu balanza…");
      const c = new SystelClient(this.link, { address: a, log: this.log, busyRetryMs: [300, 800, 1500] });
      const sig = await c.signature();
      if (sig) {
        this.address = a;
        this.addressNote = a === this.number ? "su número" : a === 0 ? "general (0): no atendió a su número ni al 1" : "el 1: no atendió a su número";
        return true;
      }
    }
    this.addressNote = "ninguno atendió la firma (su número, 1 y general)";
    return false;
  }

  /**
   * La balanza contestó E1/E2/E3 a todo (atiende el cable pero no los pedidos). Se prueba, SOLO LEYENDO la firma, lo que
   * hace distinto el programa de ejemplo oficial de Systel: señales DTR/RTS (el ejemplo las deja apagadas) y una pausa
   * después de configurar las señales antes del primer pedido (Patagonia hablaba a los 9 ms de abrir). Se queda con la
   * primera combinación que atiende y la guarda para esa balanza (también la usa Mostrador al leer tickets).
   * Real: Cuora Max nueva de Los gringos, 19/10, E3 a 54 pedidos con DTR y RTS encendidas. HIPÓTESIS: que alguna de
   * estas variantes la destrabe; se registra cada intento para soporte.
   */
  private async recoverLines(onProgress: ProgressFn): Promise<boolean> {
    const link = this.link as SystelLink & { setLines?: (dtr: boolean, rts: boolean) => Promise<void> };
    if (!link.setLines) return false;
    const variants = [
      { dtr: false, rts: false, waitMs: 2000 },
      { dtr: true, rts: false, waitMs: 1500 },
      { dtr: false, rts: true, waitMs: 1500 },
      { dtr: true, rts: true, waitMs: 3000 }
    ];
    for (const v of variants) {
      onProgress("leer", "Probando otra forma de hablarle a tu balanza…");
      await link.setLines(v.dtr, v.rts);
      await new Promise((r) => setTimeout(r, v.waitMs));
      for (const a of [...new Set([this.number, 1, 0])]) {
        const c = new SystelClient(this.link, { address: a, log: this.log, busyRetryMs: [] });
        if (await c.signature()) {
          this.address = a;
          this.lines = { dtr: v.dtr, rts: v.rts };
          this.addressNote = `atendió con DTR ${v.dtr ? "encendida" : "apagada"} y RTS ${v.rts ? "encendida" : "apagada"}, pedidos al ${a === this.number ? "suyo" : a}`;
          return true;
        }
      }
    }
    return false;
  }

  /** Señales y número con los que atendió esta balanza (se guardan con la conexión). */
  connectionHints(): { lines?: { dtr: boolean; rts: boolean }; requestAddress?: number } {
    return { ...(this.lines ? { lines: this.lines } : {}), ...(this.address !== this.number ? { requestAddress: this.address } : {}) };
  }

  async prepare(onProgress: ProgressFn): Promise<PreparedSync> {
    onProgress("leer", "Leyendo tu balanza…");
    if (!(await this.pickAddress(onProgress)) && systelRefused(this.log)) await this.recoverLines(onProgress);
    this.deps.onConnectionHints?.(this.connectionHints());
    const backup = await takeSystelBackup(this.client(), () => onProgress("leer", "Leyendo tu balanza…"));
    this.lastBackup = backup;
    if (!backup.signature && !backup.ping) {
      // E1/E2/E3 = la balanza contestó por el cable pero no hizo la orden (la Cuora de Los gringos lo hizo 13 veces del
      // 09 al 14/10; el 19/10, otra balanza, no se sabe: se perdió el registro). No es lo mismo que el silencio.
      throw new FriendlyError(systelRefused(this.log) ? "balanza_ocupada" : "no_contesta", `${backup.detail} · pedidos: ${this.addressNote}`);
    }
    this.model = systelModelFor(backup);
    this.label = SCALE_CAPABILITIES[this.model].label;

    onProgress("comparar", "Comparando con los productos de Patagonia…");
    const setup = this.ctx.online && this.ctx.branchId ? await this.deps.loadSetup(this.ctx.branchId, this.scaleKey) : null;
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
    const changing = count("actualizar");
    if (changing) notes.push(`${changing === 1 ? "1 producto que ya está" : `${changing} productos que ya están`} en la balanza cambia de precio o nombre. Los totales de venta que guarda la balanza para ${changing === 1 ? "ese producto" : "esos productos"} podrían volver a cero (no está comprobado). Las ventas de Patagonia no cambian.`);
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
        { scaleKey: this.scaleKey, brand: "systel", model: this.label, weighedFormat: values.E_P ?? null, unitFormat: values.E_U ?? null, totalFormat: values.E_S ?? null, amountDecimals: st.backup.signature?.priceDecimals ?? 0, genericCodes: [] },
        catalog
      );
      await this.deps.setLinks(this.ctx.branchId, this.scaleKey, sent.map((x) => ({ code: x.number!, kind: "product" as const, productId: x.product.id })));
      await this.deps.setActive(this.ctx.branchId, this.scaleKey, true);
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

  identity(): Record<string, unknown> {
    return { address: this.number };
  }

  supportInfo(): Record<string, unknown> {
    const b = this.state?.backup ?? this.lastBackup;
    return {
      marca: "systel",
      modelo: this.model,
      numero: this.number,
      direccion_pedidos: this.address,
      senales: this.lines ?? "DTR y RTS encendidas",
      como_se_eligio: this.addressNote,
      firma: b?.signature ?? null,
      formato: b?.layout ?? null,
      productos: b?.plus.length ?? 0,
      completo: b?.complete ?? null,
      detalle: b?.detail ?? null,
      contesto_ocupada: systelRefused(this.log),
      intercambio_sesion: this.log.slice(-200)
    };
  }
}

/** ¿La balanza contestó con un error de "no hice la orden" (E1/E2/E3)? Es una respuesta, no silencio. */
export function systelRefused(log: SystelExchangeLog[]): boolean {
  // Contestada a otro número (se le habló al 1 y respondió la 20) también cuenta: la trama trae el E3 igual.
  return log.some((l) => /^E[123]$/.test(l.rxText) && !l.result.startsWith("sin respuesta"));
}

/** El adaptador, con la base que le pase quien lo arma (systel-live.ts en la app; dobles en las pruebas). */
export function makeSystelAdapter(deps: SystelDeps): ScaleAdapter {
  return {
    family: "systel",
    async identify(port: SerialPort, ctx: EngineContext, onProgress: ProgressFn): Promise<ScaleSession | null> {
      onProgress("buscar", "Buscando tu balanza…");
      // El intercambio va al reporte de soporte: sin esto, "no contestó" llegaba sin un solo byte (Los gringos, 19/10).
      const log: SystelExchangeLog[] = [];
      const events: SystelLinkEvent[] = [];
      let found: SystelFoundLink | null = null;
      const previous = loadSavedSystelLink();
      try {
        found = await discoverSystelLink(port, log, () => onProgress("buscar", "Buscando tu balanza…"), previous, 350, events);
      } finally {
        if (ctx.diag) {
          ctx.diag.log.push(...log.slice(-300));
          ctx.diag.events.push(...events.slice(-300));
          ctx.diag.steps.push(found ? `systel: contestó el N.º ${found.address}${systelRefused(log) ? " (con E1/E2/E3: está, pero no atiende)" : ""}` : `systel: sin respuesta (${log.length} intentos)`);
        }
      }
      if (!found) return null;
      // Lo que se aprendió de ESTA balanza (señales, número al que atiende) se conserva si es la misma conexión.
      const same = previous && previous.address === found.address && previous.settings.baudRate === found.settings.baudRate;
      const hints = same ? { ...(previous.lines ? { lines: previous.lines } : {}), ...(previous.requestAddress !== undefined ? { requestAddress: previous.requestAddress } : {}) } : {};
      saveSystelLink({ settings: found.settings, address: found.address, ...hints });
      return new SystelSession(found.link, found.address, ctx, deps, hints);
    }
  };
}

