import { planAuraSync, summarizeAuraPlan, type AuraSyncItem } from "../../../inventory/kretz/aura-sync";
import { saveModelId } from "../../../inventory/kretz/models";
import {
  diagnoseScaleLink,
  expectedReportProduct,
  planScaleSync,
  readAuraListOnScale,
  readReportProduct,
  runAuraSyncOnScale,
  setScaleSerialPort,
  syncProductsToScale,
  type ReportProductFields,
  type ScaleSyncableProduct
} from "../../../inventory/scale-serial";
import { canWrite, SCALE_CAPABILITIES, type ScaleModelId } from "../capabilities";
import { FRIENDLY_MESSAGES, FriendlyError } from "../friendly";
import { normalizeName } from "../matching";
import type { EngineContext, EngineProduct, PendingItem, PreparedSync, ProgressFn, ScaleAdapter, ScaleSession, SyncOutcome } from "../types";

/**
 * Kretz (Report LT y Aura). Reutiliza, sin cambiarlos, los mismos caminos que usan los clientes hoy:
 * - Report: alta 2005 (`syncProductsToScale`, preserva los campos que no son nombre/tipo/precio) y relectura 5005;
 * - Aura: `readAuraList` → `planAuraSync` → `runAuraSync` (relee cada producto y frena ante cualquier diferencia;
 *   ajuste del código del TOTAL incluido, como el envío que ya está en producción).
 * En las Kretz el número de la balanza ES el código del producto en Patagonia: no hay vínculos que adivinar.
 * Un número ocupado por OTRO producto nunca se pisa sin autorización.
 */

export interface KretzIO {
  diagnose: typeof diagnoseScaleLink;
  readAuraList: typeof readAuraListOnScale;
  runAuraSync: typeof runAuraSyncOnScale;
  readReport: typeof readReportProduct;
  sendReport: typeof syncProductsToScale;
}

export const KRETZ_IO: KretzIO = { diagnose: diagnoseScaleLink, readAuraList: readAuraListOnScale, runAuraSync: runAuraSyncOnScale, readReport: readReportProduct, sendReport: syncProductsToScale };

export function kretzModelForLetter(deviceType: string | null | undefined): ScaleModelId {
  return deviceType === "H" ? "kretz-aura" : deviceType === "C" ? "kretz-report-lt" : "kretz-otra";
}

const toSyncable = (p: EngineProduct): ScaleSyncableProduct => ({ id: p.id, code: p.code, name: p.name, unit: p.unit as ScaleSyncableProduct["unit"], priceRetail: p.priceRetail, active: p.active });
const sameReport = (a: ReportProductFields, b: ReportProductFields) => a.name === b.name && a.byWeight === b.byWeight && a.price === b.price;

type ReportState = { kind: "report"; create: ScaleSyncableProduct[]; update: ScaleSyncableProduct[]; occupied: { product: ScaleSyncableProduct; current: ReportProductFields }[] };
type AuraState = { kind: "aura"; records: string[]; products: { code: string; name: string; byWeight: boolean; price: number }[]; plan: AuraSyncItem[] };

export class KretzSession implements ScaleSession {
  label: string;
  private state: ReportState | AuraState | null = null;

  constructor(
    readonly model: ScaleModelId,
    private readonly ctx: EngineContext,
    private readonly mode: "datos" | "peso",
    private readonly io: KretzIO = KRETZ_IO,
    private readonly diagnostic: Record<string, unknown> = {}
  ) {
    this.label = SCALE_CAPABILITIES[model].label;
  }

  private base(): Omit<PreparedSync, "scaleProducts" | "ready" | "writes" | "pending" | "upToDate"> {
    return { model: this.model, label: this.label, newLinks: 0, priceDiffs: 0, canWrite: canWrite(this.model, "sendProducts"), notes: [] };
  }

  async prepare(onProgress: ProgressFn): Promise<PreparedSync> {
    if (this.mode === "peso") {
      return {
        ...this.base(),
        canWrite: false,
        scaleProducts: 0,
        ready: 0,
        writes: 0,
        pending: [],
        upToDate: false,
        blocker: "Tu balanza está conectada en modo pesaje: Mostrador puede leer el peso. Para pasarle productos, en el menú de la balanza (COMUNI) elegí \"Datos\" y tocá \"Conectar balanza\" otra vez."
      };
    }
    if (!canWrite(this.model, "sendProducts")) {
      return { ...this.base(), canWrite: false, scaleProducts: 0, ready: 0, writes: 0, pending: [], upToDate: false, blocker: "Tu balanza Kretz respondió, pero este modelo todavía no está habilitado para recibir productos. Soporte te ayuda a habilitarlo." };
    }
    const active = this.ctx.products.filter((p) => (p.active ?? true));
    if (this.model === "kretz-aura") {
      onProgress("leer", "Leyendo los productos de tu balanza…");
      const list = await this.io.readAuraList((t) => onProgress("leer", "Leyendo los productos de tu balanza…", ...progressNumbers(t)));
      if (!list.complete) throw new FriendlyError("no_contesta", list.detail);
      onProgress("comparar", "Comparando con los productos de Patagonia…");
      const products = active.map((p) => ({ code: p.code, name: p.name, byWeight: p.unit === "kg", price: p.priceRetail }));
      const records = list.records.map((r) => r.data);
      const plan = planAuraSync(records, products);
      this.state = { kind: "aura", records, products, plan };
      const s = summarizeAuraPlan(plan);
      const pending: PendingItem[] = plan
        .filter((x) => x.action === "conflicto")
        .map((x) => ({ code: x.plu ?? 0, scaleName: x.name, byWeight: false, reason: "ocupado_en_balanza", detail: x.reason, suggestionId: null }));
      const writes = s.crear + s.actualizar + s.reemplazar;
      return { ...this.base(), scaleProducts: list.records.length, ready: s.sin_cambios, writes, pending, upToDate: writes === 0, notes: s.omitir ? [`${s.omitir} productos de Patagonia no van a la balanza (su código no sirve como número de balanza).`] : [] };
    }

    // Report: se lee cada número antes de escribir, para no pisar otro producto.
    const plan = planScaleSync(active.map(toSyncable));
    const create: ScaleSyncableProduct[] = [];
    const update: ScaleSyncableProduct[] = [];
    const occupied: ReportState["occupied"] = [];
    let same = 0;
    for (const [i, p] of plan.toSend.entries()) {
      onProgress("leer", "Leyendo los productos de tu balanza…", i + 1, plan.toSend.length);
      const current = await this.io.readReport(p.code);
      const expected = expectedReportProduct(p);
      if (!current) create.push(p);
      else if (sameReport(current, expected)) same++;
      else if (normalizeName(current.name) === normalizeName(expected.name)) update.push(p);
      else occupied.push({ product: p, current });
    }
    onProgress("comparar", "Comparando con los productos de Patagonia…");
    this.state = { kind: "report", create, update, occupied };
    const pending: PendingItem[] = occupied.map((o) => ({ code: Number(o.product.code), scaleName: o.current.name, byWeight: o.current.byWeight, reason: "ocupado_en_balanza", detail: `en la balanza el ${o.product.code} es "${o.current.name}"; en Patagonia es "${o.product.name}"`, suggestionId: null }));
    const writes = create.length + update.length;
    return { ...this.base(), scaleProducts: plan.toSend.length, ready: same, writes, pending, upToDate: writes === 0, notes: plan.skipped.length ? [`${plan.skipped.length} productos de Patagonia no van a la balanza (su código no sirve como número de balanza).`] : [] };
  }

  async sync(prepared: PreparedSync, onProgress: ProgressFn, opts: { allowReplace?: boolean } = {}): Promise<SyncOutcome> {
    const st = this.state;
    if (!st || !prepared.canWrite || prepared.blocker) throw new Error("primero hay que leer la balanza");
    if (st.kind === "aura") {
      const plan = opts.allowReplace ? planAuraSync(st.records, st.products, { replaceConflicts: true }) : st.plan;
      const r = await this.io.runAuraSync(plan, (t) => onProgress("sincronizar", "Mandando tus productos a la balanza…", ...progressNumbers(t)), () => false, true);
      if (r.verdict !== "ok") return { ok: false, verified: r.written.length, message: FRIENDLY_MESSAGES.frenado, pending: prepared.pending, support: { verdict: r.verdict, detail: r.detail, stoppedAt: r.stoppedAt } };
      return { ok: true, verified: r.written.length, message: done(opts.allowReplace ? [] : prepared.pending), pending: opts.allowReplace ? [] : prepared.pending };
    }

    const list = [...st.create, ...st.update, ...(opts.allowReplace ? st.occupied.map((o) => o.product) : [])];
    if (list.length > 0) {
      const r = await this.io.sendReport(list, (d, t) => onProgress("sincronizar", "Mandando tus productos a la balanza…", d, t));
      const bad = r.failed.length + r.noResponse.length + r.transportErrors.length;
      if (bad > 0) return { ok: false, verified: 0, message: FRIENDLY_MESSAGES.frenado, pending: prepared.pending, support: { failed: r.failed.length, noResponse: r.noResponse.length, transport: r.transportErrors.map((x) => x.message) } };
    }
    // Verificación: se relee cada producto mandado y se compara nombre, forma de venta y precio.
    let verified = 0;
    const wrong: string[] = [];
    for (const [i, p] of list.entries()) {
      onProgress("verificar", "Comprobando lo que quedó en la balanza…", i + 1, list.length);
      const back = await this.io.readReport(p.code);
      if (back && sameReport(back, expectedReportProduct(p))) verified++;
      else wrong.push(p.code);
    }
    if (wrong.length) return { ok: false, verified, message: FRIENDLY_MESSAGES.frenado, pending: prepared.pending, support: { verificacion: wrong } };
    const pending = opts.allowReplace ? [] : prepared.pending;
    return { ok: true, verified, message: done(pending), pending };
  }

  async close(): Promise<void> {
    // El puerto lo maneja scale-serial (lo cierra solo cuando queda quieto).
  }

  supportInfo(): Record<string, unknown> {
    return { marca: "kretz", modelo: this.model, modo: this.mode, ...this.diagnostic };
  }
}

function done(pending: PendingItem[]): string {
  return pending.length
    ? `¡Listo! Tu balanza está conectada y ya podés vender. ${pending.length} productos no se mandaron porque en la balanza ese número es de otro producto.`
    : "¡Listo! Tu balanza está conectada y ya podés vender.";
}

/** "PLU 12 de 223" → [12, 223] para la barra de avance. */
function progressNumbers(text: string): [number, number] | [] {
  const m = /(\d+)\s*(?:de|\/)\s*(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : [];
}

export const kretzAdapter: ScaleAdapter = {
  family: "kretz",
  async identify(port: SerialPort, ctx: EngineContext, onProgress: ProgressFn): Promise<ScaleSession | null> {
    onProgress("buscar", "Buscando tu balanza…");
    setScaleSerialPort(port);
    const d = await KRETZ_IO.diagnose(() => onProgress("buscar", "Buscando tu balanza…"), { modelId: "aura" });
    const info = { verdict: d.verdict, puerto: d.portLabel, configuracion: d.dataSettings };
    if (d.verdict === "puerto") throw new FriendlyError("puerto_ocupado", d.message);
    if (d.verdict === "peso") return new KretzSession("kretz-aura", ctx, "peso", KRETZ_IO, info);
    if (d.verdict !== "datos" || !d.dataSettings) return null;
    const model = kretzModelForLetter(d.dataSettings.deviceType);
    if (model !== "kretz-otra") saveModelId(model === "kretz-aura" ? "aura" : "report-lt");
    return new KretzSession(model, ctx, "datos", KRETZ_IO, info);
  }
};
