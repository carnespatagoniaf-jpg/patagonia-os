// Ejecutor real de los trabajos de la nube (migración 226/227) sobre los protocolos de la web (ScaleProtocolHost).
//
// - send: la balanza es scale_key → el dispositivo de ESTA PC (lo vinculó la web). Los productos vienen en el payload
//   armados como en Mis balanzas. Corre en el trabajador de ESA balanza (dos balanzas = dos envíos en paralelo). El
//   motor guarda en Patagonia por la nube (CloudEngineBackend, en nombre de quien encoló). Avance: cuántos productos
//   quedaron comprobados; al cerrar, el resultado de CADA producto (confirmado / fallado / salteado, con su motivo).
// - read con {"mode": "identify"}: busca las balanzas de los puertos de la PC, SOLO LEYENDO, y las devuelve con su
//   huella física para que la web las registre y vincule ("Agregar balanza → En esta computadora con Scale Connect").
// - test: ¿contesta la balanza vinculada? (solo lectura).
//
// El último aviso de avance lleva el mensaje para la persona (el mismo de "Mis balanzas"): la web lo muestra.

import type { CloudJob, JobContext, JobExecutor, JobItemResult, JobOutcome } from "../cloud/job-executor";
import type { CloudConfig } from "../cloud/cloud-client";
import { silentLogger, type Logger } from "../log/logger";
import type { SendResult } from "../protocols/scale-jobs";
import type { EngineProduct } from "../../../web/src/features/scales/engine/types";
import { CloudEngineBackend } from "./cloud-engine-backend";
import type { FleetDevice, IdentifyFinding, ScaleFleet } from "./scale-fleet";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Productos del payload (armados por la web como en Mis balanzas) → los del motor. Lo raro se descarta. */
export function payloadProducts(payload: Obj): EngineProduct[] {
  const list = Array.isArray(payload.products) ? payload.products : [];
  return list.filter(isObj).flatMap((p) => {
    const code = str(p.plu) ?? (typeof p.plu === "number" ? String(p.plu) : null);
    const name = str(p.name);
    const price = typeof p.price === "number" ? p.price : Number(p.price);
    if (!code || !name || !Number.isFinite(price)) return [];
    return [{ id: str(p.product_id) ?? `plu-${code}`, code, name, unit: str(p.unit) ?? "kg", priceRetail: price, active: p.active !== false }];
  });
}

const STATUS: Record<SendResult["products"][number]["status"], JobItemResult["status"]> = { confirmado: "confirmed", fallado: "failed", salteado: "skipped" };

/** Resultado del motor → productos para scale_job_items. */
export function sendItems(result: SendResult, products: EngineProduct[]): JobItemResult[] {
  const idOf = new Map(products.map((p) => [`${p.code}|${p.name}`, p.id]));
  return result.products.map((p) => {
    const id = idOf.get(`${p.code}|${p.name}`) ?? null;
    return {
      product_id: id && !id.startsWith("plu-") ? id : null,
      plu: p.code.slice(0, 40),
      action: "write",
      status: STATUS[p.status],
      reason: p.reason ? p.reason.slice(0, 300) : null,
    };
  });
}

export function sendStatus(result: SendResult): JobOutcome["status"] {
  if (result.ok && result.failed === 0) return "done";
  return result.confirmed > 0 ? "partial" : "failed";
}

/** Mensajes para la persona cuando no se pudo ni empezar (códigos del trabajador y de los protocolos). */
export function failureText(code: string, message: string, scaleName: string): string {
  if (code === "balanza_no_esta") return `"${scaleName}" no está conectada a esta computadora. Volvé a agregarla desde Mis balanzas.`;
  return message || "No se pudo hablar con la balanza.";
}

export interface ScaleJobExecutorOptions {
  fleet: ScaleFleet;
  logger?: Logger;
  /** Mínimo entre dos avisos de avance (ms). */
  progressEveryMs?: number;
  /** Se llama después de identificar (para latir enseguida con las balanzas nuevas). */
  afterIdentify?: () => void;
}

export class ScaleJobExecutor implements JobExecutor {
  private readonly log: Logger;
  private readonly progressEveryMs: number;

  constructor(private readonly options: ScaleJobExecutorOptions) {
    this.log = (options.logger ?? silentLogger).child({ part: "ejecutor" });
    this.progressEveryMs = options.progressEveryMs ?? 1000;
  }

  async execute(job: CloudJob, ctx: JobContext): Promise<JobOutcome> {
    if (job.kind === "read" && job.payload.mode === "identify") return this.identify(job, ctx);
    if (job.kind === "send") return this.send(job, ctx);
    if (job.kind === "test") return this.test(job, ctx);
    return { status: "failed", errorCode: "tipo_no_soportado", items: [] };
  }

  /** scale_key → dispositivo; si no lo sabe, pide la configuración a la nube (la web pudo vincularla recién). */
  private async device(job: CloudJob, ctx: JobContext): Promise<FleetDevice | null> {
    const fleet = this.options.fleet;
    let found = fleet.resolve(job.scaleKey);
    if (!found && ctx.cloud) {
      let config: CloudConfig | null = null;
      try {
        config = await ctx.cloud.config();
      } catch (error) {
        this.log.warn("No se pudo traer la configuración de la nube", { error });
      }
      if (config) {
        await fleet.applyConfig(config);
        found = fleet.resolve(job.scaleKey);
      }
    }
    return found;
  }

  private async send(job: CloudJob, ctx: JobContext): Promise<JobOutcome> {
    const products = payloadProducts(job.payload);
    const total = products.length;
    const device = await this.device(job, ctx);
    if (!device) {
      await ctx.progress({ done: 0, total, text: failureText("balanza_no_esta", "", job.scaleKey) });
      return { status: "failed", errorCode: "balanza_no_esta", items: [], counters: { requested: total, confirmed: 0, failed: 0, skipped: 0 } };
    }
    if (!job.branchId) return { status: "failed", errorCode: "sin_sucursal", items: [] };

    // Avance: en orden, como mucho uno por segundo (y siempre el último).
    let confirmed = 0;
    let lastSent = 0;
    let chain: Promise<void> = Promise.resolve();
    const report = (text: string, force = false) => {
      const now = Date.now();
      if (!force && now - lastSent < this.progressEveryMs) return;
      lastSent = now;
      const done = confirmed;
      chain = chain.then(() => ctx.progress({ done, total, text }));
    };
    report(`Conectando con ${device.name}…`, true);

    const backend = ctx.cloud ? new CloudEngineBackend(ctx.cloud, job.scaleKey) : undefined;
    const flags = job.payload;
    const outcome = await device.host.send(
      {
        branchId: job.branchId,
        scaleKey: job.scaleKey,
        products,
        family: this.options.fleet.familyOf(job.scaleKey) ?? device.identified?.family ?? undefined,
        allowReplace: flags.allow_replace === true,
        canManageLinks: flags.can_manage_links !== false,
        weightBarcode: flags.weight_barcode === true,
        pesosBarcode: flags.pesos_barcode === true,
        plu5Barcode: flags.plu5_barcode === true,
        backend,
        onConfirmed: () => {
          confirmed += 1;
          report(`${confirmed} de ${total} comprobados en la balanza`);
        },
      },
      job.id,
    );

    if (outcome.status !== "done") {
      const text = failureText(outcome.error.code, outcome.error.message, device.name);
      report(text, true);
      await chain;
      const reason = text.slice(0, 300);
      return {
        status: "failed",
        errorCode: outcome.error.code.slice(0, 80),
        items: products.map((p) => ({ product_id: p.id.startsWith("plu-") ? null : p.id, plu: p.code, action: "write", status: "failed", reason })),
        counters: { requested: total, confirmed: 0, failed: total, skipped: 0 },
      };
    }
    const result = outcome.result;
    confirmed = result.confirmed;
    report(result.message, true);
    await chain;
    const status = sendStatus(result);
    this.log.info("Envío terminado", { job: job.id, scale: job.scaleKey, status, confirmed: result.confirmed, failed: result.failed, skipped: result.skipped });
    return {
      status,
      errorCode: status === "done" ? null : result.failed > 0 ? "productos_fallados" : result.blocker ? "frenada_en_balanza" : "con_aviso",
      items: sendItems(result, products),
      counters: { requested: total, confirmed: result.confirmed, failed: result.failed, skipped: result.skipped },
    };
  }

  private async identify(job: CloudJob, ctx: JobContext): Promise<JobOutcome> {
    const network = (Array.isArray(job.payload.network) ? job.payload.network : [])
      .filter(isObj)
      .map((n) => ({ host: String(n.host ?? ""), port: Number(n.port) }))
      .slice(0, 10);
    let last = 0;
    const findings = await this.options.fleet.identifyAll({ network }, (done, total, text) => {
      const now = Date.now();
      if (done !== total && now - last < this.progressEveryMs) return;
      last = now;
      void ctx.progress({ done, total, text });
    });
    this.options.afterIdentify?.();
    const items = findings.filter((f) => f.found).map(identifyItem);
    return { status: "done", items, counters: { requested: findings.length, confirmed: items.length, failed: 0, skipped: findings.length - items.length } };
  }

  private async test(job: CloudJob, ctx: JobContext): Promise<JobOutcome> {
    const device = await this.device(job, ctx);
    if (!device) return { status: "failed", errorCode: "balanza_no_esta", items: [] };
    const outcome = await device.host.test({ family: this.options.fleet.familyOf(job.scaleKey) ?? device.identified?.family ?? undefined });
    const ok = outcome.status === "done" && outcome.result.ok;
    const text = outcome.status === "done" ? outcome.result.message : outcome.error.message;
    await ctx.progress({ done: 1, total: 1, text });
    return {
      status: ok ? "done" : "failed",
      errorCode: ok ? null : outcome.status === "done" ? "no_contesta" : outcome.error.code.slice(0, 80),
      items: [{ action: "verify", status: ok ? "confirmed" : "failed", reason: ok ? null : text.slice(0, 300) }],
    };
  }
}

/** Una balanza encontrada, como producto del trabajo: sent = la huella física; read_back = qué balanza es. */
export function identifyItem(f: IdentifyFinding): JobItemResult {
  return {
    action: "read",
    status: "confirmed",
    plu: null,
    reason: null,
    sent: { ...f.physical },
    read_back: {
      device_id: f.deviceId,
      name: f.name,
      family: f.result?.family ?? null,
      model: f.result?.model ?? null,
      label: f.result?.label ?? null,
      identity: f.result?.identity ?? {},
    },
  };
}
