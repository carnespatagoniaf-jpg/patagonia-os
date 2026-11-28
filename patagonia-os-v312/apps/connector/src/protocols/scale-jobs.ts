// Trabajos del conector con una balanza, usando el motor de "Mi balanza" de la web
// tal cual (adaptadores Kretz y Systel, ScaleSession prepare → sync):
//
// - identify: ¿quién está en este puerto? Corre `identify` de cada adaptador
//   (SOLO LECTURA, igual que "Conectar balanza").
// - test: prueba de conexión con la marca ya conocida (también solo lectura).
// - send: recibe los productos; identify → prepare (lee la balanza) → sync (escribe
//   solo lo comprobado y relee). Devuelve el resultado POR PRODUCTO: confirmado,
//   fallado con su motivo o salteado con su motivo.
//
// Cada trabajo corre en el trabajador de ESA balanza (cola propia, vigía, diario).
// El diario anota cada producto confirmado ("producto:<código>") apenas se
// confirma releyendo la balanza. Si el servicio se reinicia a mitad, el diario deja
// el trabajo "interrumpido"; el próximo envío no reenvía nada a ciegas: `prepare`
// SIEMPRE relee la balanza y solo escribe lo que todavía no está igual.

import type { DeviceWorker, JobContext, JobOutcome } from "../worker/device-worker";
import type { JobJournal } from "../journal/job-journal";
import type { DeviceConfig } from "../config/config";
import type { DiscoveredPort } from "../discovery/port-classify";
import { silentLogger, type Logger } from "../log/logger";
import { classifyOpenError, type LinkError } from "../link/link-error";
import { LinkReopenError } from "../link/byte-link";
import type { EngineBackend } from "./engine-backend";
import { ScaleStateStore } from "./scale-state-store";
import { WebSerialPortShim } from "./web-serial-shim";
import { instantiateWebProtocols, loadWebProtocolSource, serialFor, type WebProtocols } from "./web-runtime";
import type {
  ConnectDiag,
  EngineContext,
  EngineProduct,
  PreparedSync,
  ProgressFn,
  ScaleAdapter,
  ScaleSession,
  SyncOutcome,
} from "../../../web/src/features/scales/engine/types";
import type { KretzIO } from "../../../web/src/features/scales/engine/adapters/kretz";
import type { SystelDeps } from "../../../web/src/features/scales/engine/adapters/systel";
import type { ReportProductFields, ScaleSyncableProduct } from "../../../web/src/features/inventory/scale-serial";

export type ScaleFamily = "kretz" | "systel";

export interface ProtocolDevice {
  id: string;
  name: string;
  transport:
    | { type: "serial"; usbVendorId?: number; usbProductId?: number }
    | { type: "tcp"; host: string; port: number };
}

/** La balanza de la configuración, con el chip USB que vio el descubridor (si está enchufada). */
export function protocolDeviceFor(device: DeviceConfig, ports: Pick<DiscoveredPort, "path" | "vendorId" | "productId">[] = []): ProtocolDevice {
  const t = device.transport;
  if (t.type === "tcp") return { id: device.id, name: device.name, transport: { type: "tcp", host: t.host, port: t.port } };
  const seen = ports.find((p) => p.path.toUpperCase() === t.path.toUpperCase());
  const hex = (v: string | undefined) => (v && /^[0-9a-f]{1,4}$/i.test(v) ? parseInt(v, 16) : undefined);
  return { id: device.id, name: device.name, transport: { type: "serial", usbVendorId: hex(seen?.vendorId), usbProductId: hex(seen?.productId) } };
}

export interface IdentifyOptions {
  /** Probar solo esta marca (por ejemplo, la que ya está registrada). */
  family?: ScaleFamily;
  /** Kretz: probar solo este modelo. */
  kretzModel?: "aura" | "report-lt";
}

export interface IdentifyResult {
  found: boolean;
  family: ScaleFamily | null;
  model: string | null;
  label: string | null;
  /** Lo que la distingue de otra igual (número de balanza, letra de equipo). */
  identity: Record<string, unknown>;
  /** Por qué no la encontró cada marca (para soporte). */
  attempts: { family: ScaleFamily; error: string }[];
  support: Record<string, unknown>;
}

export interface TestResult {
  ok: boolean;
  family: ScaleFamily | null;
  model: string | null;
  label: string | null;
  message: string;
}

export interface SendInput extends IdentifyOptions {
  branchId: string;
  /** Clave de la balanza en scale_profiles (por omisión, el id del dispositivo). */
  scaleKey?: string;
  products: EngineProduct[];
  /** La persona autorizó reemplazar los números ocupados por otro producto. */
  allowReplace?: boolean;
  /** Dueño o administrador (Systel lo exige para vincular). Por omisión, sí. */
  canManageLinks?: boolean;
  weightBarcode?: boolean;
  pesosBarcode?: boolean;
  plu5Barcode?: boolean;
  /**
   * Lo que el motor le pide a Patagonia PARA ESTE envío (Scale Connect: la nube, con el trabajo y en nombre de quien lo
   * pidió). Por omisión, el del anfitrión.
   */
  backend?: EngineBackend;
  /** Cada producto que queda comprobado releyendo la balanza (para informar el avance). */
  onConfirmed?: (code: string) => void;
}

export type ProductStatus = "confirmado" | "fallado" | "salteado";

export interface ProductResult {
  code: string;
  name: string;
  status: ProductStatus;
  reason?: string;
}

export interface SendResult {
  ok: boolean;
  family: ScaleFamily;
  model: string;
  label: string;
  message: string;
  products: ProductResult[];
  confirmed: number;
  failed: number;
  skipped: number;
  /** Envíos anteriores a esta balanza que quedaron interrumpidos (se releyó antes de escribir). */
  resumedFrom: string[];
  /** Lo que la persona tiene que hacer en la balanza antes de poder mandar. */
  blocker?: string;
  support: Record<string, unknown>;
}

export interface ScaleProtocolHostOptions {
  device: ProtocolDevice;
  worker: Pick<DeviceWorker, "enqueue">;
  backend: EngineBackend;
  journal?: JobJournal;
  /** Dónde guardar el `localStorage` de esta balanza (null = solo memoria). */
  stateFile?: string | null;
  logger?: Logger;
  /** Para pruebas: otro empaquetado del código de la web. */
  loadSource?: () => Promise<string>;
  /** Vigía por tipo de trabajo (por omisión, el del trabajador). */
  watchdogMs?: Partial<Record<"identify" | "test" | "send", number>>;
}

/** Error de un trabajo con código estable (va al resultado "fallido"). */
export class ScaleJobError extends Error {
  constructor(
    /** Lo lee el trabajador como código del resultado fallido. */
    readonly jobErrorCode: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ScaleJobError";
  }
}

interface Runtime {
  mod: WebProtocols;
  store: ScaleStateStore;
  shim: WebSerialPortShim;
  /** Lo que reciben los adaptadores: el shim, o el shim con forma de balanza por red. */
  port: SerialPort;
  /** Hay un trabajo corriendo con esta instancia. */
  inUse: boolean;
}

/** La marca que contestó la última vez en esta balanza (clave del conector, no de la web). */
const FAMILY_KEY = "patagonia-connector-family";
const FTDI = 0x0403;
const SYSTEL_NET_PORT = 10001;

function emptyDiag(): ConnectDiag {
  return { usb: null, authorized: [], log: [], events: [], steps: [] };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class ScaleProtocolHost {
  readonly device: ProtocolDevice;
  private readonly options: ScaleProtocolHostOptions;
  private readonly log: Logger;
  private storePromise: Promise<ScaleStateStore> | null = null;
  private current: Runtime | null = null;
  private instances = 0;

  constructor(options: ScaleProtocolHostOptions) {
    this.options = options;
    this.device = options.device;
    this.log = (options.logger ?? silentLogger).child({ device: options.device.id, part: "protocolos" });
  }

  /** ¿Quién está en este puerto? Solo lectura. */
  identify(options: IdentifyOptions = {}, jobId?: string): Promise<JobOutcome<IdentifyResult>> {
    return this.options.worker.enqueue({
      id: jobId,
      kind: "identify",
      meta: { family: options.family ?? null },
      watchdogMs: this.options.watchdogMs?.identify,
      run: (ctx) => this.withScale(ctx, (rt) => this.runIdentify(rt, ctx, options)),
    });
  }

  /** Prueba de conexión: ¿contesta la balanza registrada? Solo lectura. */
  test(options: IdentifyOptions = {}, jobId?: string): Promise<JobOutcome<TestResult>> {
    return this.options.worker.enqueue({
      id: jobId,
      kind: "test",
      meta: { family: options.family ?? null },
      watchdogMs: this.options.watchdogMs?.test,
      run: (ctx) =>
        this.withScale(ctx, async (rt) => {
          const family = options.family ?? this.rememberedFamily(rt);
          const r = await this.runIdentify(rt, ctx, { ...options, family: family ?? undefined });
          return r.found
            ? { ok: true, family: r.family, model: r.model, label: r.label, message: `${r.label} contestó.` }
            : { ok: false, family: null, model: null, label: null, message: rt.mod.FRIENDLY_MESSAGES.no_contesta };
        }),
    });
  }

  /** Manda los productos y devuelve el resultado de cada uno, comprobado releyendo la balanza. */
  send(input: SendInput, jobId?: string): Promise<JobOutcome<SendResult>> {
    return this.options.worker.enqueue({
      id: jobId,
      kind: "send",
      meta: { branchId: input.branchId, products: input.products.length, allowReplace: input.allowReplace === true },
      watchdogMs: this.options.watchdogMs?.send,
      run: (ctx) => this.withScale(ctx, (rt) => this.runSend(rt, ctx, input)),
    });
  }

  // ───────────────────────── entorno ─────────────────────────

  /**
   * La instancia del código de la web para esta balanza. Si la anterior sigue
   * ocupada (un trabajo que el vigía abandonó y todavía no terminó de fallar), se
   * arma una NUEVA, con otro shim: el código abandonado se queda con un puerto que
   * ya nunca se vuelve a prestar y no puede hablarle a la balanza del trabajo nuevo.
   */
  private async runtime(): Promise<Runtime> {
    this.storePromise ??= ScaleStateStore.open(this.device.id, this.options.stateFile ?? null);
    this.storePromise.catch(() => {
      this.storePromise = null;
    });
    const current = this.current;
    if (current && !current.inUse) return current;
    const source = await (this.options.loadSource ?? loadWebProtocolSource)();
    const store = await this.storePromise;
    const t = this.device.transport;
    const shim = new WebSerialPortShim(t.type === "serial" ? { usbVendorId: t.usbVendorId, usbProductId: t.usbProductId } : {}, this.device.name);
    let port: SerialPort = shim as unknown as SerialPort;
    const mod = instantiateWebProtocols(source, { localStorage: store, navigator: { serial: serialFor(() => port) } });
    if (t.type === "tcp") port = mod.makeConnectorNetPort(shim, { host: t.host, port: t.port });
    const rt: Runtime = { mod, store, shim, port, inUse: false };
    if (current) this.log.warn("La instancia anterior de protocolos sigue ocupada: se arma una nueva para este trabajo");
    this.current = rt;
    this.instances += 1;
    return rt;
  }

  /** Cuántas instancias del código de la web se armaron (para estado y pruebas). */
  get instanceCount(): number {
    return this.instances;
  }

  /** Presta el enlace del trabajo al shim mientras dura `fn`. Un corte de cable sale como "closed" (interrumpido). */
  private async withScale<T>(ctx: JobContext, fn: (rt: Runtime) => Promise<T>): Promise<T> {
    let rt: Runtime;
    try {
      rt = await this.runtime();
    } catch (error) {
      throw new ScaleJobError("runtime", `No se pudo cargar el código de protocolos: ${messageOf(error)}`);
    }
    rt.inUse = true;
    rt.shim.attach({ link: ctx.link, signal: ctx.signal, onActivity: () => ctx.heartbeat() });
    try {
      const result = await fn(rt);
      if (rt.shim.lost) throw this.lostError(rt.shim.lost);
      return result;
    } catch (error) {
      if (rt.shim.lost) throw this.lostError(rt.shim.lost);
      throw error;
    } finally {
      await rt.shim.detach();
      await rt.store.flush().catch(() => undefined);
      rt.inUse = false;
    }
  }

  /**
   * El enlace se perdió. Si fue al reabrir el puerto con otra configuración y
   * Windows lo negó (otro programa lo tomó en ese instante, o no existe más), se
   * dice eso; si no, es un corte (el trabajo queda interrumpido).
   */
  private lostError(lost: LinkError): Error {
    const cause = lost.cause;
    if (lost instanceof LinkReopenError && cause !== undefined) {
      const c = classifyOpenError(cause, this.device.name);
      if (c.code === "busy_other_program" || c.code === "not_found") return new ScaleJobError(c.code, c.message);
    }
    return lost;
  }

  private rememberedFamily(rt: Runtime): ScaleFamily | null {
    const f = rt.store.getItem(FAMILY_KEY);
    return f === "kretz" || f === "systel" ? f : null;
  }

  /** Orden de las marcas: la pedida; si no, la de la última vez; si no, por el chip o el puerto de red. */
  private familyOrder(rt: Runtime, options: IdentifyOptions): ScaleFamily[] {
    if (options.family) return [options.family];
    const t = this.device.transport;
    const byHardware: ScaleFamily[] =
      t.type === "tcp" ? (t.port === SYSTEL_NET_PORT ? ["systel", "kretz"] : ["kretz", "systel"]) : t.usbVendorId === FTDI ? ["systel", "kretz"] : ["kretz", "systel"];
    const remembered = this.rememberedFamily(rt);
    return remembered ? [remembered, ...byHardware.filter((f) => f !== remembered)] : byHardware;
  }

  // ───────────────────────── identify ─────────────────────────

  private engineContext(input: Partial<SendInput>, diag: ConnectDiag): EngineContext {
    return {
      branchId: input.branchId ?? null,
      products: input.products ?? [],
      online: Boolean(input.branchId),
      canManageLinks: input.canManageLinks ?? true,
      scaleKey: input.scaleKey ?? this.device.id,
      diag,
      weightBarcode: input.weightBarcode,
      pesosBarcode: input.pesosBarcode,
      plu5Barcode: input.plu5Barcode,
    };
  }

  private async runIdentify(rt: Runtime, ctx: JobContext, options: IdentifyOptions): Promise<IdentifyResult> {
    const diag = emptyDiag();
    const engineCtx = this.engineContext({}, diag);
    const found = await this.findSession(rt, ctx, engineCtx, options, this.adapters(rt, null, options));
    if (!found.session) {
      return { found: false, family: null, model: null, label: null, identity: {}, attempts: found.attempts, support: { pasos: diag.steps, log: diag.log.slice(-50) } };
    }
    const { session, family } = found;
    try {
      return {
        found: true,
        family,
        model: session.model,
        label: session.label,
        identity: session.identity?.() ?? {},
        attempts: found.attempts,
        support: { ...session.supportInfo(), pasos: diag.steps },
      };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  private async findSession(
    rt: Runtime,
    ctx: JobContext,
    engineCtx: EngineContext,
    options: IdentifyOptions,
    adapters: ScaleAdapter[],
  ): Promise<{ session: ScaleSession | null; family: ScaleFamily | null; attempts: { family: ScaleFamily; error: string }[] }> {
    const attempts: { family: ScaleFamily; error: string }[] = [];
    // Buscar puede tener silencios largos (la Report por red prueba 99 números): cada aviso de "buscando" cuenta como avance.
    const onProgress: ProgressFn = (step) => {
      if (step === "buscar" || step === "permiso") ctx.heartbeat();
    };
    for (const family of this.familyOrder(rt, options)) {
      const adapter = adapters.find((a) => a.family === family);
      if (!adapter) continue;
      if (rt.shim.lost) throw rt.shim.lost;
      let session: ScaleSession | null = null;
      try {
        session = await adapter.identify(rt.port, engineCtx, onProgress);
      } catch (error) {
        if (rt.shim.lost) throw rt.shim.lost;
        if (rt.mod.isPortOpenError(error)) {
          const kind = rt.mod.friendlyKind(error);
          throw new ScaleJobError(kind === "puerto_ocupado" ? "in_use_here" : "busy_other_program", rt.mod.FRIENDLY_MESSAGES.puerto_otro_programa, {
            tecnico: messageOf(error),
          });
        }
        attempts.push({ family, error: messageOf(error) });
        continue;
      }
      if (session) {
        rt.store.setItem(FAMILY_KEY, family);
        return { session, family, attempts };
      }
      attempts.push({ family, error: "no contestó" });
    }
    if (rt.shim.lost) throw rt.shim.lost;
    return { session: null, family: null, attempts };
  }

  // ───────────────────────── adaptadores ─────────────────────────

  private adapters(rt: Runtime, tracker: ConfirmTracker | null, options: IdentifyOptions, backend: EngineBackend = this.options.backend): ScaleAdapter[] {
    const { mod } = rt;
    const io: KretzIO = {
      ...mod.KRETZ_IO,
      saveItemConfig: (branchId, config = mod.AURA_ITEM_SCALE_CONFIG) => backend.saveBranchScaleConfig(branchId, config),
      loadBranchConfig: (branchId) => backend.loadBranchScaleConfig(branchId),
      listBranchScales: (branchId) => backend.listBranchScales(branchId),
    };
    const deps: SystelDeps = {
      loadSetup: (branchId, scaleKey) => backend.loadScaleSetup(branchId, scaleKey),
      saveCatalog: async (branchId, profile, catalog) => {
        const r = await backend.saveScaleCatalog(branchId, profile, catalog);
        await tracker?.systelCatalog(catalog);
        return r;
      },
      setLinks: (branchId, scaleKey, links) => backend.setScaleLinks(branchId, scaleKey, links),
      setActive: (branchId, scaleKey, active) => backend.setScaleProfileActive(branchId, scaleKey, active),
      saveLocalBackup: (backup, scaleKey) => mod.saveProductBackupLocally(backup, scaleKey),
      onConnectionHints: (hints) => {
        const saved = mod.loadSavedSystelLink();
        if (saved) mod.saveSystelLink({ settings: saved.settings, address: saved.address, ...hints });
      },
      forceWritable: false,
    };
    return [mod.makeKretzAdapter(tracker ? tracker.kretzIO(io) : io, undefined, options.kretzModel ?? null), mod.makeSystelAdapter(deps)];
  }

  // ───────────────────────── send ─────────────────────────

  private async runSend(rt: Runtime, ctx: JobContext, input: SendInput): Promise<SendResult> {
    if (!input.branchId) throw new ScaleJobError("bad_request", "Falta la sucursal del envío.");
    const resumedFrom = (this.options.journal?.list({ deviceId: this.device.id, status: "interrupted" }) ?? [])
      .filter((j) => j.kind === "send" && j.id !== ctx.jobId)
      .map((j) => j.id);
    const diag = emptyDiag();
    const engineCtx = this.engineContext(input, diag);
    const tracker = new ConfirmTracker(rt.mod, input.products, ctx, input.onConfirmed);
    const backend = input.backend ?? this.options.backend;
    const family = input.family ?? this.rememberedFamily(rt) ?? undefined;
    const found = await this.findSession(rt, ctx, engineCtx, { ...input, family }, this.adapters(rt, tracker, input, backend));
    if (!found.session || !found.family) {
      throw new ScaleJobError("no_contesta", rt.mod.FRIENDLY_MESSAGES.no_contesta, { intentos: found.attempts, pasos: diag.steps });
    }
    const session = found.session;
    const onProgress: ProgressFn = () => undefined;
    let prepared: PreparedSync | null = null;
    let outcome: SyncOutcome | null = null;
    try {
      // Relee la balanza ANTES de escribir (también al reanudar un envío interrumpido).
      prepared = await session.prepare(onProgress);
      if (rt.shim.lost) throw rt.shim.lost;
      if (!prepared.blocker && prepared.canWrite && !prepared.upToDate) {
        outcome = await session.sync(prepared, onProgress, { allowReplace: input.allowReplace === true });
      }
      if (rt.shim.lost) throw rt.shim.lost;
      const result = this.buildResult(found.family, session, prepared, outcome, tracker, input, resumedFrom);
      if (!result.ok) await this.report(ctx, "send", result.ok, result.message, { ...result.support, sesion: session.supportInfo(), pasos: diag.steps }, backend);
      return result;
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  private buildResult(
    family: ScaleFamily,
    session: ScaleSession,
    prepared: PreparedSync,
    outcome: SyncOutcome | null,
    tracker: ConfirmTracker,
    input: SendInput,
    resumedFrom: string[],
  ): SendResult {
    const skipped = new Map<string, string>();
    for (const s of prepared.skipped ?? []) skipped.set(`${s.code}|${s.name}`, s.reason);
    const pending = new Map<number, string>();
    for (const p of outcome?.pending ?? prepared.pending) pending.set(p.code, p.detail || "en la balanza ese número es de otro producto");
    const failures = new Map<string, string>();
    for (const f of outcome?.failures ?? []) failures.set(String(Number(f.code)), f.reason);
    const general = prepared.blocker ?? (outcome && !outcome.ok ? outcome.message : "no se pudo comprobar en la balanza");

    const products: ProductResult[] = input.products.map((p) => {
      const key = String(Number(p.code));
      const base = { code: p.code, name: p.name };
      if (tracker.isConfirmed(p.code)) return { ...base, status: "confirmado" };
      const skip = skipped.get(`${p.code}|${p.name}`);
      if (skip) return { ...base, status: "salteado", reason: skip };
      const busy = pending.get(Number(p.code));
      if (busy) return { ...base, status: "salteado", reason: busy };
      const fail = failures.get(key) ?? tracker.problem(p.code);
      return { ...base, status: "fallado", reason: fail ?? general };
    });
    const confirmed = products.filter((p) => p.status === "confirmado").length;
    const failed = products.filter((p) => p.status === "fallado").length;
    const skippedCount = products.filter((p) => p.status === "salteado").length;
    const ok = failed === 0 && !prepared.blocker && (outcome ? outcome.ok : true);
    const message = prepared.blocker ?? outcome?.message ?? (prepared.upToDate ? "La balanza ya tiene los mismos productos y precios que Patagonia." : general);
    return {
      ok,
      family,
      model: session.model,
      label: session.label,
      message,
      products,
      confirmed,
      failed,
      skipped: skippedCount,
      resumedFrom,
      ...(prepared.blocker ? { blocker: prepared.blocker } : {}),
      support: { preparado: { ...prepared, skipped: undefined, warnings: undefined }, envio: outcome?.support ?? null, identidad: session.identity?.() ?? {} },
    };
  }

  private async report(
    ctx: JobContext,
    kind: "identify" | "test" | "send",
    ok: boolean,
    message: string,
    detail: Record<string, unknown>,
    backend: EngineBackend = this.options.backend,
  ): Promise<void> {
    try {
      await backend.reportToSupport({ deviceId: this.device.id, jobId: ctx.jobId, kind, ok, message, detail });
    } catch (error) {
      this.log.warn("No se pudo mandar el reporte a soporte", { error });
    }
  }
}

/**
 * Qué productos quedaron comprobados en la balanza, con la MISMA comparación que usa
 * la web (reportDifferences / planAuraSync / lo que Systel guarda para Mostrador).
 * Cada confirmado se anota en el diario al instante.
 */
class ConfirmTracker {
  private readonly confirmedCodes = new Set<string>();
  private readonly problems = new Map<string, string>();
  private readonly byCode = new Map<string, EngineProduct[]>();

  constructor(
    private readonly mod: WebProtocols,
    private readonly products: EngineProduct[],
    private readonly ctx: JobContext,
    private readonly onConfirmed?: (code: string) => void,
  ) {
    for (const p of products) {
      const key = this.key(p.code);
      this.byCode.set(key, [...(this.byCode.get(key) ?? []), p]);
    }
  }

  private key(code: string | number): string {
    const n = Number(code);
    return Number.isFinite(n) ? String(n) : String(code);
  }

  isConfirmed(code: string): boolean {
    return this.confirmedCodes.has(this.key(code));
  }

  problem(code: string): string | undefined {
    return this.problems.get(this.key(code));
  }

  private async confirm(code: string | number, data: Record<string, unknown>): Promise<void> {
    const key = this.key(code);
    this.problems.delete(key);
    if (this.confirmedCodes.has(key)) return;
    // Un solo producto con ese código: con dos, ninguno se da por confirmado (lo frena la revisión previa).
    if ((this.byCode.get(key) ?? []).length !== 1) return;
    this.confirmedCodes.add(key);
    await this.ctx.confirmStep(`producto:${key}`, data);
    try {
      this.onConfirmed?.(key);
    } catch {
      // el aviso de avance nunca frena el envío
    }
  }

  private unconfirm(code: string | number, reason: string): void {
    const key = this.key(code);
    this.confirmedCodes.delete(key);
    this.problems.set(key, reason);
  }

  private syncable(p: EngineProduct): ScaleSyncableProduct {
    return { id: p.id, code: p.code, name: p.name, unit: p.unit as ScaleSyncableProduct["unit"], priceRetail: p.priceRetail, active: p.active };
  }

  /** Kretz: se observa cada lectura y cada envío por las mismas funciones que usa el motor. */
  kretzIO(io: KretzIO): KretzIO {
    const auraProducts = () => this.products.map((p) => ({ code: p.code, name: p.name, byWeight: p.unit === "kg", price: p.priceRetail }));
    const auraRecords = async (records: string[]) => {
      for (const item of this.mod.planAuraSync(records, auraProducts())) {
        if (item.plu === null) continue;
        if (item.action === "sin_cambios") await this.confirm(item.plu, { relectura: "aura" });
        else if (this.isConfirmed(String(item.plu))) this.unconfirm(item.plu, "al releer la balanza no quedó igual");
      }
    };
    return {
      ...io,
      readReport: async (code) => {
        const fields = await io.readReport(code);
        await this.reportRead(code, fields);
        return fields;
      },
      readAuraList: async (onProgress) => {
        const list = await io.readAuraList(onProgress);
        if (list.complete) await auraRecords(list.records.map((r) => r.data));
        return list;
      },
      runAuraSync: async (...args) => {
        const result = await io.runAuraSync(...args);
        for (const w of result.written) await this.confirm(w.plu, { escrito: w.action });
        if (result.after.length > 0 && result.verdict !== "lectura_incompleta") await auraRecords(result.after.map((r) => r.data));
        return result;
      },
    };
  }

  private async reportRead(code: string, fields: ReportProductFields | null): Promise<void> {
    const list = this.byCode.get(this.key(code)) ?? [];
    if (list.length !== 1) return;
    const expected = this.mod.expectedReportProduct(this.syncable(list[0]));
    const diffs = fields ? this.mod.reportDifferences(fields, expected) : ["al releerlo, el número está vacío en la balanza"];
    if (diffs.length === 0) await this.confirm(code, { relectura: "report" });
    else if (this.isConfirmed(code)) this.unconfirm(code, diffs.join("; "));
  }

  /** Systel: el motor guarda para Mostrador lo que quedó escrito y releído (o ya estaba igual). */
  async systelCatalog(catalog: Parameters<SystelDeps["saveCatalog"]>[2]): Promise<void> {
    for (const c of catalog) {
      const list = this.byCode.get(this.key(c.code)) ?? [];
      if (list.length !== 1) continue;
      const p = list[0];
      const sameSale = (c.saleType === "P") === (p.unit === "kg");
      if (c.prices[0] === p.priceRetail && sameSale) await this.confirm(c.code, { relectura: "systel" });
    }
  }
}
