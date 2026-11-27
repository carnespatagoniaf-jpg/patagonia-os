import { parseAuraPlu } from "../../../inventory/kretz/aura-plu";
import { AURA_BARCODE_CONFIG, AURA_BARCODE_CONFIG_22, AURA_ITEM_SCALE_CONFIG, auraMaySetBranchConfig, planAuraSync, summarizeAuraPlan, type AuraSyncItem } from "../../../inventory/kretz/aura-sync";
import { AURA_PREFIX_22_BRANCHES } from "../weight-barcode";
import { kretz1070ForSpec, readKey, specFromKretz1070, specPrefixes, type LabelSpec } from "../../label-spec";
import type { PrefixAllocation } from "../../label-spec-service";
import { getStoredModelId, saveModelId } from "../../../inventory/kretz/models";
import { isNetPort } from "../../../inventory/kretz/net-port";
import { KRETZ_PLU5_WEIGHT_CONFIG } from "../../../sale/scan-resolve";
import type { ScaleConfig } from "../../../sale/scale-barcode";
import { BRANCH_CONFIG_PROTECTED, branchConfigSupport, mayWriteBranchScaleConfig, type BranchConfigDecision, type BranchScaleRef } from "../../../inventory/kretz/branch-scale-guard";
import { chooseReportLabel, describeLabelSamples, type ReportLabelSample } from "../../../inventory/kretz/report-label";
import {
  configureReportBarcode,
  diagnoseScaleLink,
  expectedReportProduct,
  planScaleSync,
  readAuraListOnScale,
  readReportLabelSample,
  readReportProduct,
  releaseScaleSerialPort,
  reportDifferences,
  setReportLabelCode,
  runAuraSyncOnScale,
  ScaleReadError,
  setScaleSerialPort,
  syncProductsToScale,
  type ReportProductFields,
  type ScaleSyncableProduct
} from "../../../inventory/scale-serial";
import { canWrite, MODEL_LIMITS, SCALE_CAPABILITIES, type ScaleModelId } from "../capabilities";
import { preflightProducts, type PreflightResult } from "../preflight";
import { FRIENDLY_MESSAGES, FriendlyError, SENT_AND_CHECKED } from "../friendly";
import { normalizeName } from "../matching";
import type { EngineContext, EngineProduct, PendingItem, PreparedSync, ProductProblem, ProgressFn, ScaleAdapter, ScaleCatalogEntry, ScaleSession, SyncOutcome } from "../types";

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
  saveItemConfig?: (branchId: string, config?: ScaleConfig) => Promise<void>;
  /** Formato de etiqueta que la sucursal ya tiene guardado (null = ninguno). Sin esto, la Aura no cambia el formato. */
  loadBranchConfig?: (branchId: string) => Promise<ScaleConfig | null>;
  /**
   * Las balanzas registradas de la sucursal (scale_profiles). Sin esto (pruebas, demo) el formato se guarda como antes.
   * Con más de una activa, el formato de la sucursal solo se cambia si queda igual (mayWriteBranchScaleConfig, C1).
   */
  listBranchScales?: (branchId: string) => Promise<BranchScaleRef[]>;
  /** Report: manda el formato del código de barras de las etiquetas (1070). */
  configureReportBarcode?: (config?: string) => Promise<"ok" | "rechazada" | "sin_respuesta">;
  /** Report: primeros productos de la balanza con su formato de etiqueta (solo lectura). */
  readLabelSample?: () => Promise<ReportLabelSample[]>;
  /** Report: formato de etiqueta con el que se graban (y se verifican) los productos. */
  setLabelCode?: (code: string) => void;
  /** Report: cierra el puerto al terminar (C21); `forget` = además olvidarlo (fin de la sesión). */
  releasePort?: (options?: { forget?: boolean }) => Promise<void>;
  /** 'balanzas_v2': inicio propio de ESTA balanza (la que ya tiene el suyo lo conserva). Sin esto, no se asigna. */
  allocatePrefix?: (branchId: string, scaleKey: string) => Promise<PrefixAllocation | null>;
  /** 'balanzas_v2': guarda el perfil de ESTA balanza (la base rechaza un inicio que usa otra del local). */
  saveLabelSpec?: (branchId: string, scaleKey: string, spec: LabelSpec) => Promise<unknown>;
}

/** 'balanzas_v2': no se cambió cómo imprime las etiquetas esta balanza (inicio ocupado, sin conexión, Report por red). */
export const LABEL_SPEC_PROTECTED = "Los productos quedaron bien en la balanza, pero no se cambió cómo imprime las etiquetas (su perfil de etiqueta no se pudo guardar). Avisamos a soporte.";

/** 'balanzas_v2', Aura: no se mandó nada porque su perfil de etiqueta no se pudo guardar. */
export const LABEL_SPEC_NOT_SENT = "No se mandó nada a la balanza: no se pudo guardar cómo imprime sus etiquetas (su perfil de etiqueta). Avisamos a soporte.";

export const KRETZ_IO: KretzIO = {
  diagnose: diagnoseScaleLink,
  readAuraList: readAuraListOnScale,
  runAuraSync: runAuraSyncOnScale,
  readReport: readReportProduct,
  sendReport: syncProductsToScale,
  configureReportBarcode,
  readLabelSample: () => readReportLabelSample(),
  setLabelCode: setReportLabelCode,
  releasePort: releaseScaleSerialPort
};

/**
 * 1070 para la Report por red (Nx §4.17): inicio pesable "21" + peso (1) + inicio no pesable "20" + importe (0) +
 * formato 1 (2-5-5). Es lo que imprimía la NX2 de Lauda antes de recibir el 2-3-7 (2100037017403 = PLU 37, 1,740 kg).
 */
export const REPORT_NET_BARCODE_CONFIG = "2112001";

/** Código más alto que entra en esa etiqueta (5 cifras del 2-5-5). */
export const REPORT_NET_LABEL_MAX_CODE = 99999;

/**
 * 1070 para la Report por USB/Bluetooth con etiqueta por peso (ctx.weightBarcode): inicio pesable "21" + peso (1) +
 * inicio no pesable "20" + importe (0) + formato 5 (2-3-7). Los no pesables y las etiquetas viejas siguen "20" + importe,
 * así Mostrador lee las dos (scan-resolve: "21" con el formato 2-3-7 de la sucursal = gramos).
 */
export const REPORT_WEIGHT_BARCODE_CONFIG = "2112005";

/**
 * 1070 para la Report con importe en pesos enteros (ctx.pesosBarcode): inicio pesable "20" + importe (0) + inicio no
 * pesable "20" + importe (0) + formato 1 (2-5-5). Es lo que imprimía la Report LT de El Abastero antes del 24/11/2026
 * ("2 00017 19521 6" = FALDA $19.521); la sucursal lo lee con REPORT_PESOS_SCALE_CONFIG.
 */
export const REPORT_PESOS_BARCODE_CONFIG = "2002001";

/** Cómo lee Mostrador esa etiqueta: 1-6-5 en pesos (mismos dígitos que el 2-5-5; así lo tenía calibrado El Abastero). */
export const REPORT_PESOS_SCALE_CONFIG: ScaleConfig = { prefixLength: 1, pluLength: 6, weightLength: 5, weightDivisor: 1, totalLength: 13, payloadType: "amount" };

export function kretzModelForLetter(deviceType: string | null | undefined): ScaleModelId {
  return deviceType === "H" ? "kretz-aura" : deviceType === "C" ? "kretz-report-lt" : "kretz-otra";
}

const toSyncable = (p: EngineProduct): ScaleSyncableProduct => ({ id: p.id, code: p.code, name: p.name, unit: p.unit as ScaleSyncableProduct["unit"], priceRetail: p.priceRetail, active: p.active });
// Todo cuenta: nombre, forma de venta, precio, impuestos (la balanza los suma al imprimir), código de la etiqueta,
// formato de etiqueta (el 01 imprime el código de barras) y decimales (otro flag corre el precio).
const sameReport = (a: ReportProductFields, b: ReportProductFields) => reportDifferences(a, b).length === 0;
const problem = (p: ScaleSyncableProduct, reason: string): ProductProblem => ({ code: p.code, name: p.name, reason });

/** El contexto puede traer la lista de balanzas de la sucursal (la que ya tiene Mi balanza); si no, se pide a la base. */
export type KretzContext = EngineContext & { branchScales?: BranchScaleRef[] };

type ReportState = { kind: "report"; create: ScaleSyncableProduct[]; update: ScaleSyncableProduct[]; occupied: { product: ScaleSyncableProduct; current: ReportProductFields }[] };
type AuraState = { kind: "aura"; records: string[]; products: { code: string; name: string; byWeight: boolean; price: number }[]; plan: AuraSyncItem[] };

export class KretzSession implements ScaleSession {
  label: string;
  private state: ReportState | AuraState | null = null;
  /** C1: el formato de la sucursal no se cambió porque el local tiene otra balanza (dato para soporte). */
  private protectedConfig: Record<string, unknown> | null = null;
  /** 'balanzas_v2': el 1070 que corresponde a esta balanza (después de asignarle el inicio). */
  private v2Code: string | null = null;

  constructor(
    readonly model: ScaleModelId,
    private readonly ctx: EngineContext,
    private readonly mode: "datos" | "peso",
    private readonly io: KretzIO = KRETZ_IO,
    private readonly diagnostic: Record<string, unknown> = {}
  ) {
    this.label = SCALE_CAPABILITIES[model].label;
  }

  /** Aura: lo leído (D/C en pesos enteros, P/N con centavos). La Report no se lee entera: solo los números de Patagonia. */
  scaleCatalog(): ScaleCatalogEntry[] | null {
    if (this.state?.kind !== "aura") return null;
    return this.state.records.flatMap((r) => {
      const p = parseAuraPlu(r);
      if (!p || !/^\d+$/.test(p.priceRaw.trim())) return [];
      const cents = p.type === "P" || p.type === "N";
      return [{ number: p.plu, name: p.name, byWeight: p.type === "D" || p.type === "P", price: cents ? Number(p.priceRaw) / 100 : Number(p.priceRaw) }];
    });
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
      // Lectura incompleta (un error en el medio de la lista): no se arma ningún plan, así nada parece "libre" (C8).
      if (!list.complete) return this.readIncomplete(list.detail, list.records.length);
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
      // Nunca "ya está igual" sin el código de barras (1070) confirmado en ESTA Aura (C13): antes una Aura con los
      // productos iguales nunca recibía el 1070.
      const barcodeReady = isBarcodeConfigured(this.auraBarcodeKey());
      const notes = barcodeReady ? [] : ["Falta configurar el código de barras de los tickets: se hace al sincronizar."];
      return { ...this.base(), scaleProducts: list.records.length, ready: s.sin_cambios, writes, pending, upToDate: writes === 0 && barcodeReady, notes, skipped, warnings: check.warnings };
    }

    // Report: se lee cada número antes de escribir, para no pisar otro producto. Al terminar se suelta el puerto (C21).
    try {
      return await this.prepareReport(onProgress, check);
    } finally {
      await this.release(false);
    }
  }

  private async prepareReport(onProgress: ProgressFn, check: PreflightResult): Promise<PreparedSync> {
    const active = check.ready;
    const plan = planScaleSync(active.map(toSyncable));
    // Formato de etiqueta: el que ya usan los productos reales de ESTA balanza (en la NX2 de Lauda el "01" sale sin
    // código de barras, real 18/11). Se elige antes de comparar, así un producto grabado con otro formato se corrige.
    let labelNote: string | null = null;
    if (this.io.readLabelSample && this.io.setLabelCode) {
      onProgress("leer", "Revisando cómo imprime las etiquetas tu balanza…");
      try {
        const samples = await this.io.readLabelSample();
        const codes = plan.toSend.map((p) => Number(p.code));
        const label = chooseReportLabel(samples, codes, { preferOther: this.diagnostic.red === true });
        this.io.setLabelCode(label);
        this.diagnostic.formato_etiqueta = { elegido: label, muestras: samples.slice(0, 40) };
        labelNote = `Formato de etiqueta: ${label}. En la balanza: ${describeLabelSamples(samples, codes)}.`;
      } catch (err) {
        this.diagnostic.formato_etiqueta = { error: err instanceof Error ? err.message : String(err) };
        labelNote = `No se pudo revisar el formato de etiqueta de la balanza (${err instanceof Error ? err.message : String(err)}).`;
      }
    }
    const create: ScaleSyncableProduct[] = [];
    const update: ScaleSyncableProduct[] = [];
    const occupied: ReportState["occupied"] = [];
    let same = 0;
    for (const [i, p] of plan.toSend.entries()) {
      onProgress("leer", "Leyendo los productos de tu balanza…", i + 1, plan.toSend.length);
      let current: ReportProductFields | null;
      try {
        current = await this.io.readReport(p.code);
      } catch (err) {
        // La balanza contestó con un error al leer ese número: no se sabe qué tiene, así que no se escribe nada (C8).
        if (err instanceof ScaleReadError) return this.readIncomplete(err.message, i);
        throw err;
      }
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
    // Por red (Report NX/NX2) se muestra siempre qué formato de etiqueta encontró: así soporte lo ve en la pantalla.
    const showLabel = labelNote !== null && this.diagnostic.red === true;
    if (showLabel) notes.push(labelNote!);
    return { ...this.base(), scaleProducts: plan.toSend.length, ready: same, writes, pending, upToDate: writes === 0 && barcodeReady && !showLabel, skipped, warnings: check.warnings, notes };
  }

  /** No se pudo leer toda la balanza: frena antes de escribir (sin botón de sincronizar) y va a soporte. */
  private readIncomplete(detail: string, read: number): PreparedSync {
    this.state = null;
    this.diagnostic.lectura_incompleta = { detalle: detail, leidos: read };
    return { ...this.base(), canWrite: false, scaleProducts: read, ready: 0, writes: 0, pending: [], upToDate: false, blocker: READ_INCOMPLETE, notes: [detail] };
  }

  async sync(prepared: PreparedSync, onProgress: ProgressFn, opts: { allowReplace?: boolean } = {}): Promise<SyncOutcome> {
    const st = this.state;
    if (!st || !prepared.canWrite || prepared.blocker) throw new Error("primero hay que leer la balanza");
    if (st.kind === "aura") {
      const plan = opts.allowReplace ? planAuraSync(st.records, st.products, { replaceConflicts: true }) : st.plan;
      // 'balanzas_v2': primero el perfil de ESTA Aura (inicio propio), después el 1070 de ese perfil.
      if (this.ctx.balanzasV2) {
        const v2 = await this.v2Barcode();
        if (!v2.ok) return { ok: false, verified: 0, message: LABEL_SPEC_NOT_SENT, pending: prepared.pending, support: v2.support };
      }
      const barcodeConfig = this.ctx.balanzasV2 ? this.v2Code! : this.auraBarcodeConfig() === AURA_BARCODE_CONFIG_22 ? AURA_BARCODE_CONFIG_22 : undefined;
      const r = await this.io.runAuraSync(plan, (t) => onProgress("sincronizar", "Mandando tus productos a la balanza…", ...progressNumbers(t)), () => false, true, barcodeConfig);
      if (r.verdict !== "ok") {
        const at = r.stoppedAt;
        // Cada producto pedido que no quedó releído igual, con su motivo: el que frenó el envío y los que no se llegaron a
        // mandar (envios-fallas.test.ts). Antes solo se informaba el primero y el historial decía "1 fallado" de 200.
        const writtenPlus = new Set(r.written.map((w) => w.plu));
        const failures: ProductProblem[] = plan
          .filter((x) => x.plu !== null && x.record && (x.action === "crear" || x.action === "actualizar" || x.action === "reemplazar") && !writtenPlus.has(x.plu))
          .map((x) => {
            const product = st.products.find((p) => Number(p.code) === x.plu);
            const reason =
              at && at.plu === x.plu
                ? at.readBack === null ? "la balanza no lo devolvió al releerlo" : "al releerlo en la balanza no quedó igual a Patagonia"
                : "no quedó comprobado en la balanza: el envío se frenó antes";
            return { code: product?.code ?? String(x.plu), name: product?.name ?? x.name, reason };
          });
        const nothingWritten = r.verdict === "lectura_incompleta" && r.written.length === 0;
        return { ok: false, verified: r.written.length, message: nothingWritten ? READ_INCOMPLETE : FRIENDLY_MESSAGES.frenado, pending: prepared.pending, failures, support: { verdict: r.verdict, detail: r.detail, stoppedAt: r.stoppedAt } };
      }
      // La Aura imprime el TOTAL en los tickets con varios productos (manual Aura Eco §7.1.7; el código por producto
      // del ticket de suma no existe: real Pollo y mar 15/10). En Pre-Empaque (ALT + 7) imprime un ticket por producto
      // con su código 2-3-7 + importe: Mostrador de la sucursal queda leyendo ese formato, salvo que la sucursal ya
      // tenga otro guardado (el de otra balanza del local: auraMaySetBranchConfig). Si no se puede leer, no se toca.
      // El 1070 tiene que contestar "01": si no, los productos quedaron pero los tickets pueden salir sin código (C13).
      if (r.barcode !== "ok") {
        return { ok: false, verified: r.written.length, message: AURA_BARCODE_FAILED, pending: opts.allowReplace ? [] : prepared.pending, support: { codigo_de_barras: r.barcode, detail: r.detail } };
      }
      markBarcodeConfigured(this.auraBarcodeKey());
      let protectedSupport: Record<string, unknown> | null = null;
      // Con 'balanzas_v2' el formato de la sucursal no se toca nunca: Mostrador lee el perfil de cada balanza.
      if (!this.ctx.balanzasV2 && this.ctx.online && this.ctx.branchId && this.io.saveItemConfig && this.io.loadBranchConfig) {
        try {
          const existing = await this.io.loadBranchConfig(this.ctx.branchId);
          if (auraMaySetBranchConfig(existing)) {
            // Y además, si el local tiene otra balanza, solo si el formato no cambia (C1).
            const g = await this.branchConfigDecision(AURA_ITEM_SCALE_CONFIG, existing);
            if (g.decision.allowed) await this.io.saveItemConfig(this.ctx.branchId);
            else protectedSupport = g.support;
          }
        } catch {
          // sin esto, Mostrador sigue leyendo el TOTAL (detalle a mano); no frena la sincronización
        }
      }
      if (protectedSupport) {
        return { ok: false, verified: r.written.length, message: `Los productos quedaron bien en la balanza. ${BRANCH_CONFIG_PROTECTED}`, pending: opts.allowReplace ? [] : prepared.pending, support: protectedSupport };
      }
      return { ok: true, verified: r.written.length, message: done(opts.allowReplace ? [] : prepared.pending), pending: opts.allowReplace ? [] : prepared.pending };
    }

    try {
      return await this.syncReport(st, prepared, onProgress, opts);
    } finally {
      await this.release(false);
    }
  }

  private async syncReport(st: ReportState, prepared: PreparedSync, onProgress: ProgressFn, opts: { allowReplace?: boolean }): Promise<SyncOutcome> {
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
      let back: ReportProductFields | null;
      try {
        back = await this.io.readReport(p.code);
      } catch (err) {
        // Sin poder releerlo no está comprobado, pero los demás sí: antes este error cortaba todo y se perdía qué quedó
        // confirmado (el historial decía 0 de N). Ahora es un producto fallado más (envios-fallas.test.ts).
        failures.push(problem(p, `no se pudo releer para comprobarlo (${err instanceof Error ? err.message : String(err)})`));
        continue;
      }
      const diffs = back ? reportDifferences(back, expectedReportProduct(p)) : ["al releerlo, el número está vacío en la balanza"];
      if (diffs.length === 0) verified++;
      else failures.push(problem(p, diffs.join("; ")));
    }
    if (this.protectedConfig) Object.assign(support, this.protectedConfig);
    if (failures.length) {
      support.verificacion = failures;
      return { ok: false, verified, message: failedMessage(verified, failures.length), pending: prepared.pending, failures, support };
    }
    if (barcode === "protegido") {
      const message = this.ctx.balanzasV2 ? LABEL_SPEC_PROTECTED : `Los productos quedaron bien en la balanza. ${BRANCH_CONFIG_PROTECTED}`;
      return { ok: false, verified, message, pending: opts.allowReplace ? [] : prepared.pending, support };
    }
    if (barcode !== "ok") {
      return { ok: false, verified, message: BARCODE_FAILED, pending: prepared.pending, support };
    }
    const pending = opts.allowReplace ? [] : prepared.pending;
    return { ok: true, verified, message: done(pending), pending };
  }

  /** Report: formato del código de barras (1070) + Mostrador leyendo ese formato. "ok" solo si la balanza lo aceptó. */
  private async configureBarcode(onProgress: ProgressFn): Promise<"ok" | "rechazada" | "sin_respuesta" | "error" | "protegido"> {
    if (!this.io.configureReportBarcode) return "ok";
    onProgress("sincronizar", "Configurando el código de barras de las etiquetas…");
    if (this.ctx.balanzasV2) return this.configureBarcodeV2();
    try {
      // Por red (Report NX/NX2): el formato que traía la balanza (21 + producto de 5 + peso). Con el 2-3-7 la NX2 de
      // Lauda dejó de imprimir el código de barras (real 18/11). Por USB/Bluetooth (Report LT) sigue el 2-3-7, salvo las
      // empresas que imprimen igual que por red (REPORT_PLU5_WEIGHT_COMPANIES, Oliem).
      const net = this.plu5();
      const pesos = !net && !this.ctx.weightBarcode && this.ctx.pesosBarcode === true;
      const saveBranch = this.ctx.online && this.ctx.branchId && this.io.saveItemConfig ? this.io.saveItemConfig : null;
      if (saveBranch) {
        // C1: con otra balanza en el local y un formato distinto, no se toca nada: ni el de la sucursal ni el de esta
        // balanza (si la balanza cambiara su etiqueta y Mostrador no, sus etiquetas se cobrarían mal).
        const g = await this.branchConfigDecision(net ? KRETZ_PLU5_WEIGHT_CONFIG : pesos ? REPORT_PESOS_SCALE_CONFIG : AURA_ITEM_SCALE_CONFIG);
        if (!g.decision.allowed) {
          this.protectedConfig = g.support;
          return "protegido";
        }
      }
      const r = await this.io.configureReportBarcode(net ? REPORT_NET_BARCODE_CONFIG : this.ctx.weightBarcode ? REPORT_WEIGHT_BARCODE_CONFIG : pesos ? REPORT_PESOS_BARCODE_CONFIG : undefined);
      if (r === "ok") {
        if (saveBranch) await saveBranch(this.ctx.branchId!, net ? KRETZ_PLU5_WEIGHT_CONFIG : pesos ? REPORT_PESOS_SCALE_CONFIG : undefined);
        markBarcodeConfigured(this.barcodeKey());
      }
      return r;
    } catch {
      return "error";
    }
  }

  /** 'balanzas_v2': el 1070 del perfil de ESTA balanza; nunca el formato de la sucursal. */
  private async configureBarcodeV2(): Promise<"ok" | "rechazada" | "sin_respuesta" | "error" | "protegido"> {
    try {
      const v2 = await this.v2Barcode();
      if (!v2.ok) {
        this.protectedConfig = v2.support;
        return "protegido";
      }
      const r = await this.io.configureReportBarcode!(v2.code);
      if (r === "ok") markBarcodeConfigured(this.barcodeKey());
      return r;
    } catch {
      return "error";
    }
  }

  /**
   * 'balanzas_v2': perfil de ESTA balanza y su 1070. Primero el inicio (allocate_scale_prefix: si el suyo lo usa otra
   * balanza del local, recibe uno libre); después, si el 1070 que se va a mandar no es el del perfil guardado (perfil
   * cargado de la sucursal, o Report sin 1070 elegido), se guarda el perfil de ese 1070 ANTES de mandarlo (el anterior
   * queda vigente 7 días). Si algo de eso no se puede, no se manda nada.
   */
  private async v2Barcode(): Promise<{ ok: true; code: string } | { ok: false; support: Record<string, unknown> }> {
    if (this.v2Code) return { ok: true, code: this.v2Code };
    const ctx = this.ctx;
    const fail = (motivo: string, extra: Record<string, unknown> = {}) => ({ ok: false as const, support: { etapa: "perfil_etiqueta_protegido", motivo, ...extra } });
    let spec = ctx.labelSpec ?? null;
    const online = ctx.online && !!ctx.branchId && !!ctx.scaleKey;
    if (online && this.io.allocatePrefix) {
      try {
        const a = await this.io.allocatePrefix(ctx.branchId!, ctx.scaleKey!);
        if (a) spec = a.spec;
      } catch (err) {
        return fail("no se pudo asignar el inicio de etiqueta", { detalle: err instanceof Error ? err.message : String(err) });
      }
    }
    const aura = this.model === "kretz-aura";
    const net = this.diagnostic.red === true;
    // Sin 1070 en el perfil (Report cargada desde la sucursal): el de hoy según la conexión.
    const code = (spec && kretz1070ForSpec(spec)) ?? (aura ? AURA_BARCODE_CONFIG : net ? REPORT_NET_BARCODE_CONFIG : AURA_BARCODE_CONFIG);
    const target = specFromKretz1070(code);
    if (!target) return fail("1070 sin lectura conocida", { codigo: code });
    // Report por red con el 2-3-7: la NX2 de Lauda dejó de imprimir el código de barras (real 18/11). No sin probarlo.
    if (net && !aura && target.layout.code !== 5) return fail("Report por red con un perfil 2-3-7 (sin probar por red)", { codigo: code });
    const same = !!spec && readKey(spec) === readKey(target) && kretz1070ForSpec(spec) === code && specPrefixes(spec).join() === specPrefixes(target).join();
    if (!same) {
      if (!online || !this.io.saveLabelSpec) return fail("sin conexión para guardar el perfil de la balanza", { codigo: code });
      try {
        await this.io.saveLabelSpec(ctx.branchId!, ctx.scaleKey!, target);
      } catch (err) {
        return fail("no se pudo guardar el perfil de la balanza", { codigo: code, detalle: err instanceof Error ? err.message : String(err) });
      }
    }
    this.v2Code = code;
    return { ok: true, code };
  }

  /**
   * C1: ¿se puede guardar `next` como formato de etiqueta de la sucursal? Lista de balanzas: la del contexto, o la de la
   * base (si no se puede leer, no se guarda). Sin forma de pedirla (pruebas, demo) se guarda como antes.
   */
  private async branchConfigDecision(next: ScaleConfig, known?: ScaleConfig | null): Promise<{ decision: BranchConfigDecision; support: Record<string, unknown> }> {
    const ctx = this.ctx as KretzContext;
    let scales: BranchScaleRef[] | null = [];
    if (ctx.branchScales) scales = ctx.branchScales;
    else if (this.io.listBranchScales && ctx.branchId) scales = await this.io.listBranchScales(ctx.branchId).catch(() => null);
    let existing: ScaleConfig | null | undefined = known;
    let decision = mayWriteBranchScaleConfig({ scales, currentKey: ctx.scaleKey ?? null, existing, next });
    // El formato guardado solo hace falta si hay otra balanza: se lee recién ahí.
    if (!decision.allowed && existing === undefined && this.io.loadBranchConfig && ctx.branchId) {
      existing = await this.io.loadBranchConfig(ctx.branchId).catch(() => undefined);
      decision = mayWriteBranchScaleConfig({ scales, currentKey: ctx.scaleKey ?? null, existing, next });
    }
    return { decision, support: branchConfigSupport(decision, next, existing, scales) };
  }

  /** Etiqueta "21" + producto de 5 + peso: la Report por red, o una por USB de una empresa que imprime igual (Oliem). */
  private plu5(): boolean {
    // 'balanzas_v2': lo dice el perfil de la balanza (2-5-5), no una lista de empresas.
    if (this.ctx.balanzasV2) {
      const code = this.ctx.labelSpec ? kretz1070ForSpec(this.ctx.labelSpec) : null;
      return code ? code.endsWith("1") : this.diagnostic.red === true;
    }
    return this.diagnostic.red === true || this.ctx.plu5Barcode === true;
  }

  /** Revisión previa con los límites del modelo (capabilities.ts). Un modelo sin límites conocidos no manda nada. */
  private preflight(): PreflightResult {
    const limits = MODEL_LIMITS[this.model];
    if (!limits) return { ready: [], problems: [], warnings: [] };
    // Por red (Report NX/NX2) la etiqueta lleva el código de 5 cifras (REPORT_NET_BARCODE_CONFIG, 2-5-5) y Mostrador
    // lo lee así (KRETZ_PLU5_WEIGHT_CONFIG): el límite de 3 cifras del 2-3-7 no corre. REAL Oliem 25/11/2026: con ese
    // límite, sus 24 productos por kilo con código 6000-6xxx (asado, vacío…) nunca se mandaban, y los que estaban
    // cargados a mano en la balanza salían con código 0 y otro precio.
    if (this.model === "kretz-report-lt" && this.plu5()) return preflightProducts(this.ctx.products, { ...limits, labelMaxCode: REPORT_NET_LABEL_MAX_CODE });
    return preflightProducts(this.ctx.products, limits);
  }

  /** Formato del código de barras (1070) que recibe esta Aura: con inicio 22 en los locales que lo tienen. */
  private auraBarcodeConfig(): string {
    if (this.ctx.balanzasV2) return this.v2Code ?? (this.ctx.labelSpec && kretz1070ForSpec(this.ctx.labelSpec)) ?? AURA_BARCODE_CONFIG;
    return this.ctx.branchId && AURA_PREFIX_22_BRANCHES.has(this.ctx.branchId) ? AURA_BARCODE_CONFIG_22 : AURA_BARCODE_CONFIG;
  }

  /** Marca "1070 confirmado" de ESTA Aura (misma lista que la Report, con otra clave). */
  private auraBarcodeKey(): string {
    const id = this.identity();
    return `${this.ctx.scaleKey ?? ""}|${String(id.letter ?? "")}${String(id.equipment ?? "")}|aura:${this.auraBarcodeConfig()}`;
  }

  private barcodeKey(): string {
    const id = this.identity();
    // Por red se marca aparte: así una NX que ya recibió el 2-3-7 vuelve a recibir su formato.
    if (this.ctx.balanzasV2) return `${this.ctx.scaleKey ?? ""}|${String(id.letter ?? "")}${String(id.equipment ?? "")}|v2:${this.v2Code ?? (this.ctx.labelSpec && kretz1070ForSpec(this.ctx.labelSpec)) ?? ""}`;
    return `${this.ctx.scaleKey ?? ""}|${String(id.letter ?? "")}${String(id.equipment ?? "")}${this.plu5() ? `|${REPORT_NET_BARCODE_CONFIG}` : this.ctx.weightBarcode ? `|${REPORT_WEIGHT_BARCODE_CONFIG}` : this.ctx.pesosBarcode ? `|${REPORT_PESOS_BARCODE_CONFIG}` : ""}`;
  }

  /** Fin de la sesión: la Report suelta el puerto y se olvida (C21). La Aura ya lo cierra en cada operación. */
  async close(): Promise<void> {
    await this.release(true);
  }

  /** Report por cable: cierra el puerto (lo libera para iTegra); por red no hay nada que soltar. */
  private async release(forget: boolean): Promise<void> {
    if (this.model === "kretz-aura" || this.diagnostic.red === true || !this.io.releasePort) return;
    try {
      await this.io.releasePort({ forget });
    } catch {
      // no frena nada
    }
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

/** C8: una lectura de la balanza con error en el medio. Nada se escribió. */
export const READ_INCOMPLETE = "No se pudo leer toda la balanza. No se cambió nada. Revisá el cable y tocá \"Conectar balanza\" de nuevo; si se repite, soporte ya recibió el detalle.";

/** C13: la Aura no confirmó el 1070. */
export const AURA_BARCODE_FAILED =
  "Los productos quedaron, pero el código de barras no: la balanza no aceptó el ajuste del código de barras de los tickets y Mostrador puede no leerlos. Tocá \"Volver a sincronizar\"; si se repite, soporte ya recibió el detalle.";

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
        // Por red, si la balanza no contesta al número 1 se buscan los 99 números: avisar que puede tardar.
        const text = isNetPort(port) ? "Buscando tu balanza por la red… puede tardar hasta 3 minutos. No la apagues." : "Buscando tu balanza…";
        const d = await io.diagnose(() => onProgress("buscar", text), { modelId });
        const info = { verdict: d.verdict, red: isNetPort(port), puerto: d.portLabel, configuracion: d.dataSettings, buscado_como: modelId, intentos_anteriores: tried.slice() };
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
