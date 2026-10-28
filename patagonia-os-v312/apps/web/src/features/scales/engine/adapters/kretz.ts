import { planAuraSync, summarizeAuraPlan, type AuraSyncItem } from "../../../inventory/kretz/aura-sync";
import { getStoredModelId, saveModelId } from "../../../inventory/kretz/models";
import {
  configureReportBarcode,
  diagnoseScaleLink,
  expectedReportProduct,
  planScaleSync,
  readAuraListOnScale,
  readReportProduct,
  reportDifferences,
  runAuraSyncOnScale,
  setScaleSerialPort,
  syncProductsToScale,
  type ReportProductFields,
  type ScaleSyncableProduct
} from "../../../inventory/scale-serial";
import { canWrite, MODEL_LIMITS, SCALE_CAPABILITIES, type ScaleModelId } from "../capabilities";
import { preflightProducts, type PreflightResult } from "../preflight";
import { FRIENDLY_MESSAGES, FriendlyError, SENT_AND_CHECKED } from "../friendly";
import { normalizeName } from "../matching";
import type { EngineContext, EngineProduct, PendingItem, PreparedSync, ProductProblem, ProgressFn, ScaleAdapter, ScaleSession, SyncOutcome } from "../types";

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
  /** Mostrador de la sucursal lee los códigos por producto de la Aura (2-3-7 con importe). Solo con base. */
  saveItemConfig?: (branchId: string) => Promise<void>;
  /** Report: manda el formato del código de barras de las etiquetas (1070). */
  configureReportBarcode?: () => Promise<"ok" | "rechazada" | "sin_respuesta">;
}

export const KRETZ_IO: KretzIO = { diagnose: diagnoseScaleLink, readAuraList: readAuraListOnScale, runAuraSync: runAuraSyncOnScale, readReport: readReportProduct, sendReport: syncProductsToScale, configureReportBarcode };

export function kretzModelForLetter(deviceType: string | null | undefined): ScaleModelId {
  return deviceType === "H" ? "kretz-aura" : deviceType === "C" ? "kretz-report-lt" : "kretz-otra";
}

const toSyncable = (p: EngineProduct): ScaleSyncableProduct => ({ id: p.id, code: p.code, name: p.name, unit: p.unit as ScaleSyncableProduct["unit"], priceRetail: p.priceRetail, active: p.active });
// Todo cuenta: nombre, forma de venta, precio, impuestos (la balanza los suma al imprimir), código de la etiqueta,
// formato de etiqueta (el 01 imprime el código de barras) y decimales (otro flag corre el precio).
const sameReport = (a: ReportProductFields, b: ReportProductFields) => reportDifferences(a, b).length === 0;
const problem = (p: ScaleSyncableProduct, reason: string): ProductProblem => ({ code: p.code, name: p.name, reason });

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
    // Etapa 1: se revisa todo antes de leer la balanza. Lo que no se puede mandar exacto no se manda (con su motivo).
    const check = this.preflight();
    const active = check.ready;
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
      const skipped = [...check.problems, ...plan.filter((x) => x.action === "omitir").map((x) => ({ code: String(x.plu ?? ""), name: x.name, reason: x.reason }))];
      return { ...this.base(), scaleProducts: list.records.length, ready: s.sin_cambios, writes, pending, upToDate: writes === 0, notes: [], skipped, warnings: check.warnings };
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
      // Un número con el producto de ejemplo de fábrica ("NOMBRE", o sin nombre) cuenta como libre:
      // una Report LT recién sacada de la caja lo trae así (real: M2 Alimentos, 24/10, PLU 1 "NOMBRE" a $955481 por unidad).
      if (!current || isFactoryPlaceholder(current.name)) create.push(p);
      else if (sameReport(current, expected)) same++;
      else if (normalizeName(current.name) === normalizeName(expected.name)) update.push(p);
      else occupied.push({ product: p, current });
    }
    onProgress("comparar", "Comparando con los productos de Patagonia…");
    this.state = { kind: "report", create, update, occupied };
    const pending: PendingItem[] = occupied.map((o) => ({ code: Number(o.product.code), scaleName: o.current.name, byWeight: o.current.byWeight, reason: "ocupado_en_balanza", detail: `en la balanza el ${o.product.code} es "${o.current.name}"; en Patagonia es "${o.product.name}"`, suggestionId: null }));
    const writes = create.length + update.length;
    const skipped = [...check.problems, ...plan.skipped.map((x) => problem(x.product, x.reason))];
    // Nunca "ya está todo listo" sin el código de barras configurado en ESTA balanza.
    const barcodeReady = !this.io.configureReportBarcode || isBarcodeConfigured(this.barcodeKey());
    const notes = barcodeReady ? [] : ["Falta configurar el código de barras de las etiquetas: se hace al sincronizar."];
    return { ...this.base(), scaleProducts: plan.toSend.length, ready: same, writes, pending, upToDate: writes === 0 && barcodeReady, skipped, warnings: check.warnings, notes };
  }

  async sync(prepared: PreparedSync, onProgress: ProgressFn, opts: { allowReplace?: boolean } = {}): Promise<SyncOutcome> {
    const st = this.state;
    if (!st || !prepared.canWrite || prepared.blocker) throw new Error("primero hay que leer la balanza");
    if (st.kind === "aura") {
      const plan = opts.allowReplace ? planAuraSync(st.records, st.products, { replaceConflicts: true }) : st.plan;
      const r = await this.io.runAuraSync(plan, (t) => onProgress("sincronizar", "Mandando tus productos a la balanza…", ...progressNumbers(t)), () => false, true);
      if (r.verdict !== "ok") {
        const at = r.stoppedAt;
        const product = at ? st.products.find((p) => Number(p.code) === at.plu) : undefined;
        const failures: ProductProblem[] = at
          ? [{ code: String(at.plu), name: product?.name ?? "", reason: at.readBack === null ? "la balanza no lo devolvió al releerlo" : "al releerlo en la balanza no quedó igual a Patagonia" }]
          : [];
        return { ok: false, verified: r.written.length, message: FRIENDLY_MESSAGES.frenado, pending: prepared.pending, failures, support: { verdict: r.verdict, detail: r.detail, stoppedAt: r.stoppedAt } };
      }
      // La Aura imprime el TOTAL en los tickets con varios productos (manual Aura Eco §7.1.7; el código por producto
      // del ticket de suma no existe: real Pollo y mar 15/10). En Pre-Empaque (ALT + 7) imprime un ticket por producto
      // con su código 2-3-7 + importe: Mostrador de la sucursal queda leyendo ese formato.
      if (r.barcode === "ok" && this.ctx.online && this.ctx.branchId && this.io.saveItemConfig) {
        try {
          await this.io.saveItemConfig(this.ctx.branchId);
        } catch {
          // sin esto, Mostrador sigue leyendo el TOTAL (detalle a mano); no frena la sincronización
        }
      }
      return { ok: true, verified: r.written.length, message: done(opts.allowReplace ? [] : prepared.pending), pending: opts.allowReplace ? [] : prepared.pending };
    }

    const list = [...st.create, ...st.update, ...(opts.allowReplace ? st.occupied.map((o) => o.product) : [])];
    // Cada producto que no quedó bien, con su motivo. Uno que falla no frena a los demás, pero nunca se dice "Listo".
    const failures: ProductProblem[] = [];
    const support: Record<string, unknown> = {};
    // PRIMERO el código de barras de las etiquetas (2-3-7 con el importe) y Mostrador leyéndolo, siempre: sin
    // código de barras la balanza no sirve para vender escaneando (pedido del dueño 25/10). Antes iba al final y
    // solo si todo salía bien; si los productos ya estaban iguales, nunca se mandaba.
    const barcode = await this.configureBarcode(onProgress);
    support.codigo_de_barras = barcode;
    if (list.length > 0) {
      const r = await this.io.sendReport(list, (d, t) => onProgress("sincronizar", "Mandando tus productos a la balanza…", d, t));
      for (const x of r.skipped) failures.push(problem(x.product, x.reason));
      for (const x of r.failed) failures.push(problem(x.product, `la balanza no lo aceptó (respuesta ${x.responseCode ?? "?"})`));
      for (const x of r.noResponse) failures.push(problem(x.product, "la balanza no contestó al grabarlo"));
      for (const x of r.transportErrors) failures.push(problem(x.product, `se cortó la comunicación al grabarlo (${x.message})`));
      support.envio = { failed: r.failed.length, noResponse: r.noResponse.length, transport: r.transportErrors.map((x) => x.message), codes: r.responseCodeCounts };
    }
    // Verificación: se relee cada producto mandado (5005) y se comparan TODOS los campos que importan.
    let verified = 0;
    const toCheck = list.filter((p) => !failures.some((f) => f.code === p.code));
    for (const [i, p] of toCheck.entries()) {
      onProgress("verificar", "Comprobando lo que quedó en la balanza…", i + 1, toCheck.length);
      const back = await this.io.readReport(p.code);
      const diffs = back ? reportDifferences(back, expectedReportProduct(p)) : ["al releerlo, el número está vacío en la balanza"];
      if (diffs.length === 0) verified++;
      else failures.push(problem(p, diffs.join("; ")));
    }
    if (failures.length) {
      support.verificacion = failures;
      return { ok: false, verified, message: failedMessage(verified, failures.length), pending: prepared.pending, failures, support };
    }
    if (barcode !== "ok") {
      return { ok: false, verified, message: BARCODE_FAILED, pending: prepared.pending, support };
    }
    const pending = opts.allowReplace ? [] : prepared.pending;
    return { ok: true, verified, message: done(pending), pending };
  }

  /** Report: formato del código de barras (1070) + Mostrador leyendo ese formato. "ok" solo si la balanza lo aceptó. */
  private async configureBarcode(onProgress: ProgressFn): Promise<"ok" | "rechazada" | "sin_respuesta" | "error"> {
    if (!this.io.configureReportBarcode) return "ok";
    onProgress("sincronizar", "Configurando el código de barras de las etiquetas…");
    try {
      const r = await this.io.configureReportBarcode();
      if (r === "ok") {
        if (this.ctx.online && this.ctx.branchId && this.io.saveItemConfig) await this.io.saveItemConfig(this.ctx.branchId);
        markBarcodeConfigured(this.barcodeKey());
      }
      return r;
    } catch {
      return "error";
    }
  }

  /** Revisión previa con los límites del modelo (capabilities.ts). Un modelo sin límites conocidos no manda nada. */
  private preflight(): PreflightResult {
    const limits = MODEL_LIMITS[this.model];
    if (!limits) return { ready: [], problems: [], warnings: [] };
    return preflightProducts(this.ctx.products, limits);
  }

  private barcodeKey(): string {
    const id = this.identity();
    return `${this.ctx.scaleKey ?? ""}|${String(id.letter ?? "")}${String(id.equipment ?? "")}`;
  }

  async close(): Promise<void> {
    // El puerto lo maneja scale-serial (lo cierra solo cuando queda quieto).
  }

  identity(): Record<string, unknown> {
    const c = (this.diagnostic.configuracion ?? null) as { deviceType?: string; equipmentId?: string } | null;
    return c ? { letter: c.deviceType ?? null, equipment: c.equipmentId ?? null } : {};
  }

  supportInfo(): Record<string, unknown> {
    return { marca: "kretz", modelo: this.model, modo: this.mode, ...this.diagnostic };
  }
}

/** Nombre del producto de ejemplo que traen de fábrica las Report ("NOMBRE") o un número vacío. */
export function isFactoryPlaceholder(name: string | null | undefined): boolean {
  const n = normalizeName(name ?? "");
  // De fábrica: "NOMBRE" o "NOMBRE 00002" (con el número de PLU), real M2 Alimentos 24/10.
  return n === "" || /^NOMBRE *\d*$/.test(n);
}

const BARCODE_FAILED =
  "Los productos quedaron bien, pero la balanza no aceptó el formato del código de barras: las etiquetas pueden salir sin código. Tocá \"Volver a sincronizar\"; si se repite, soporte ya recibió el detalle.";

/** Balanzas Report en las que ya se configuró el código de barras desde esta computadora. */
const BARCODE_KEY = "patagonia-report-barcode-ok";

function isBarcodeConfigured(key: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(BARCODE_KEY) ?? "[]") as string[]).includes(key);
  } catch {
    return false;
  }
}

function markBarcodeConfigured(key: string): void {
  try {
    const list = JSON.parse(localStorage.getItem(BARCODE_KEY) ?? "[]") as string[];
    if (!list.includes(key)) localStorage.setItem(BARCODE_KEY, JSON.stringify([...list, key]));
  } catch {
    // sin localStorage: se vuelve a mandar en cada sincronización, que no hace daño
  }
}

function failedMessage(verified: number, failed: number): string {
  const bad = failed === 1 ? "1 producto no quedó bien" : `${failed} productos no quedaron bien`;
  return verified > 0 ? `${bad} en la balanza (${verified} sí quedaron bien). Abajo está cuál y por qué.` : `${bad} en la balanza. Abajo está cuál y por qué.`;
}

function done(pending: PendingItem[]): string {
  return pending.length
    ? `${SENT_AND_CHECKED} ${pending.length} productos no se mandaron porque en la balanza ese número es de otro producto.`
    : SENT_AND_CHECKED;
}

/** "PLU 12 de 223" → [12, 223] para la barra de avance. */
function progressNumbers(text: string): [number, number] | [] {
  const m = /(\d+)\s*(?:de|\/)\s*(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : [];
}

/**
 * En qué orden se buscan las Kretz: primero el modelo que ya se usó en esta PC, después el otro.
 * La Aura (9600, 2 bits de stop, "H") y la Report LT (115200, 1 bit de stop, "C") no se encuentran con la
 * configuración de la otra: buscando solo como Aura, una Report LT real nunca contestaba (Carnes Patagonia, 16/10).
 */
export function kretzSearchOrder(stored: string | null): ("aura" | "report-lt")[] {
  return stored === "report-lt" ? ["report-lt", "aura"] : ["aura", "report-lt"];
}

/** El adaptador Kretz con las funciones que le pase quien lo arma (live.ts suma guardar el formato en la base). */
export function makeKretzAdapter(io: KretzIO, storedModel: () => string | null = getStoredModelId, only: "aura" | "report-lt" | null = null): ScaleAdapter {
  return {
    family: "kretz",
    async identify(port: SerialPort, ctx: EngineContext, onProgress: ProgressFn): Promise<ScaleSession | null> {
      onProgress("buscar", "Buscando tu balanza…");
      setScaleSerialPort(port);
      const tried: Record<string, unknown>[] = [];
      // Si el cliente eligió su modelo, se conecta solo con ese (en segundos); si no, se prueban los dos.
      for (const modelId of only ? [only] : kretzSearchOrder(storedModel())) {
        const d = await io.diagnose(() => onProgress("buscar", "Buscando tu balanza…"), { modelId });
        const info = { verdict: d.verdict, puerto: d.portLabel, configuracion: d.dataSettings, buscado_como: modelId, intentos_anteriores: tried.slice() };
        if (d.verdict === "puerto") throw new FriendlyError("puerto_ocupado", d.message);
        if (d.verdict === "peso") return new KretzSession("kretz-aura", ctx, "peso", io, info);
        if (d.verdict === "datos" && d.dataSettings) {
          const model = kretzModelForLetter(d.dataSettings.deviceType);
          if (model !== "kretz-otra") saveModelId(model === "kretz-aura" ? "aura" : "report-lt");
          return new KretzSession(model, ctx, "datos", io, info);
        }
        tried.push({ buscado_como: modelId, verdict: d.verdict, detalle: d.message });
        ctx.diag?.steps.push(`kretz ${modelId}: ${d.verdict}`);
      }
      ctx.diag?.log.push({ kretz: tried });
      throw new Error(`kretz no contestó: ${JSON.stringify(tried)}`);
    }
  };
}

export const kretzAdapter: ScaleAdapter = makeKretzAdapter(KRETZ_IO);
