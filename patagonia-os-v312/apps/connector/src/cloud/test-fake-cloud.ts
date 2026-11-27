// Nube simulada para las pruebas: un servidor HTTP en 127.0.0.1 que imita scale-connect-pair y
// scale-connect-api (mismas rutas, encabezado, códigos HTTP y reglas que las migraciones 226 y 227), en memoria.
// Con `scales` imita también scale_profiles (en qué puerto de qué PC está cada balanza) y la ruta /engine (el motor
// guarda el formato de etiqueta, el catálogo y los vínculos de la sucursal; solo con un trabajo en curso de esa PC y
// solo para la balanza del trabajo).
// Se puede "cortar" (cierra cada conexión sin responder) o hacer fallar con 503 para probar la reconexión.

import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

type Obj = Record<string, any>;

export interface FakeConnector {
  id: string;
  secret: string;
  company: string;
  name: string;
  fingerprint: string | null;
  revoked: boolean;
  version: string | null;
  lastSeen: number | null;
  scales: Array<{ key: string; name: string; online: boolean; device?: Obj; family?: string; model?: string; label?: string; identity?: Obj }>;
}

/** Una fila de scale_profiles (lo que la web registró y vinculó). */
export interface FakeScaleProfile {
  key: string;
  name: string;
  family: "kretz" | "systel";
  model: string | null;
  identity: Obj;
  active: boolean;
  connectorId: string | null;
  device: Obj | null;
}

export interface FakeJob {
  id: string;
  company: string;
  connectorId: string | null;
  scaleKey: string;
  kind: "send" | "test" | "read";
  payload: Obj;
  status: "queued" | "running" | "done" | "partial" | "failed";
  progressSeq: number;
  progress: Obj[];
  items: Obj[];
  error: string | null;
  queuedAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
}

export class FakeCloud {
  readonly server: http.Server;
  port = 0;
  mode: "up" | "down" | "error503" = "up";
  /** Cuánto espera /claim vacío antes de contestar null (la consulta larga, en chico). */
  claimWaitMs = 30;
  readonly codes = new Map<string, { company: string; used: boolean }>();
  readonly connectors = new Map<string, FakeConnector>();
  readonly jobs: FakeJob[] = [];
  readonly calls: string[] = [];
  /** scale_profiles de la sucursal. Vacío = la configuración de antes (una kretz-1 fija). */
  readonly scales: FakeScaleProfile[] = [];
  readonly engineCalls: Array<{ jobId: string; action: string; args: Obj }> = [];
  branchConfig: Obj | null = null;
  readonly catalogs = new Map<string, Obj>();
  readonly links = new Map<string, Obj[]>();
  readonly reports: Obj[] = [];

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/functions/v1`;
  }

  async start(port = 0): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen({ host: "127.0.0.1", port }, () => resolve()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  addCode(code: string, company = "A"): void {
    this.codes.set(code, { company, used: false });
  }

  queueJob(input: Partial<FakeJob> & { scaleKey: string }): FakeJob {
    const job: FakeJob = {
      id: randomUUID(),
      company: input.company ?? "A",
      connectorId: input.connectorId ?? null,
      scaleKey: input.scaleKey,
      kind: input.kind ?? "send",
      payload: input.payload ?? {},
      status: "queued",
      progressSeq: 0,
      progress: [],
      items: [],
      error: null,
      queuedAt: Date.now(),
      claimedAt: null,
      finishedAt: null,
    };
    this.jobs.push(job);
    return job;
  }

  revoke(id: string): void {
    const c = this.connectors.get(id);
    if (c) c.revoked = true;
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.mode === "down") {
      req.socket.destroy();
      return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const path = (req.url ?? "").replace(/^\/functions\/v1\//, "");
    this.calls.push(path);
    if (this.mode === "error503") return this.send(res, 503, { ok: false, error: "error_interno" });
    let body: Obj = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return this.send(res, 400, { ok: false, error: "json_invalido" });
    }
    if (path === "scale-connect-pair") return this.pair(body, res);
    const route = path.startsWith("scale-connect-api/") ? path.slice("scale-connect-api/".length) : "";
    const header = String(req.headers["x-scale-connector"] ?? "");
    const [id, secret] = header.split(".");
    const conn = this.connectors.get(id ?? "");
    if (!conn || conn.secret !== secret) return this.send(res, 401, { ok: false, error: "credencial_invalida" });
    if (conn.revoked) return this.send(res, 403, { ok: false, error: "revocado", message: "Esta computadora fue desvinculada" });
    switch (route) {
      case "heartbeat":
        conn.lastSeen = Date.now();
        conn.version = body.version ?? null;
        conn.scales = body.scales ?? [];
        return this.send(res, 200, { ok: true, name: conn.name, branch_id: "b1", queued: this.jobs.filter((j) => this.canTake(conn, j)).length });
      case "claim": {
        let job = this.jobs.find((j) => this.canTake(conn, j));
        if (!job && body.wait > 0) {
          await new Promise((r) => setTimeout(r, this.claimWaitMs));
          job = this.jobs.find((j) => this.canTake(conn, j));
        }
        if (!job) return this.send(res, 200, { ok: true, job: null });
        job.status = "running";
        job.connectorId = conn.id;
        job.claimedAt = Date.now();
        return this.send(res, 200, { ok: true, job: { id: job.id, kind: job.kind, scale_key: job.scaleKey, branch_id: "b1", requested: 0, payload: job.payload, queued_at: null } });
      }
      case "progress": {
        const job = this.jobs.find((j) => j.id === body.job_id && j.company === conn.company && j.connectorId === conn.id);
        if (!job) return this.send(res, 404, { ok: false, error: "no_existe" });
        if (job.status !== "running") return this.send(res, 409, { ok: false, error: "cerrado" });
        if (body.seq <= job.progressSeq) return this.send(res, 200, { ok: true, duplicate: true });
        job.progressSeq = body.seq;
        job.progress.push({ done: body.done, total: body.total, text: body.text });
        job.items.push(...(body.items ?? []));
        return this.send(res, 200, { ok: true, items: (body.items ?? []).length });
      }
      case "finish": {
        const job = this.jobs.find((j) => j.id === body.job_id && j.company === conn.company && j.connectorId === conn.id);
        if (!job) return this.send(res, 404, { ok: false, error: "no_existe" });
        if (job.status !== "running") return this.send(res, 409, { ok: false, error: "cerrado" });
        job.status = body.status;
        job.items.push(...(body.items ?? []));
        job.error = body.error ?? null;
        job.finishedAt = Date.now();
        return this.send(res, 200, { ok: true, result: { id: job.id, status: job.status } });
      }
      case "config": {
        const scales = this.scales.length
          ? this.scales.map((s) => ({ key: s.key, name: s.name, family: s.family, brand: s.family, model: s.model, identity: s.identity, active: s.active, device: s.connectorId === conn.id ? s.device : null }))
          : [{ key: "kretz-1", name: "Report" }];
        return this.send(res, 200, { ok: true, connector: { id: conn.id, name: conn.name, branch_id: "b1" }, company_name: `Carnicería ${conn.company}`, branch_name: "Centro", scales });
      }
      case "engine":
        return this.engine(conn, body, res);
      default:
        return this.send(res, 404, { ok: false, error: "no_existe" });
    }
  }

  private engine(conn: FakeConnector, body: Obj, res: http.ServerResponse): void {
    const job = this.jobs.find((j) => j.id === body.job_id && j.company === conn.company && j.connectorId === conn.id);
    if (!job) return this.send(res, 404, { ok: false, error: "no_existe" });
    if (job.status !== "running") return this.send(res, 409, { ok: false, error: "cerrado" });
    const args: Obj = body.args ?? {};
    const action = String(body.action ?? "");
    if (["load_scale_setup", "save_scale_catalog", "set_scale_links", "set_scale_profile_active"].includes(action) && args.scale_key !== job.scaleKey) {
      return this.send(res, 400, { ok: false, error: "datos_invalidos", message: "Esa balanza no es la de este trabajo" });
    }
    this.engineCalls.push({ jobId: job.id, action, args });
    switch (action) {
      case "load_branch_config":
        return this.send(res, 200, { ok: true, config: this.branchConfig });
      case "list_branch_scales":
        return this.send(res, 200, { ok: true, scales: this.scales.map((s) => ({ key: s.key, active: s.active })) });
      case "load_scale_setup": {
        const catalog = this.catalogs.get(job.scaleKey);
        if (!catalog) return this.send(res, 200, { ok: true, profile: null, items: [] });
        const links = this.links.get(job.scaleKey) ?? [];
        const items = (catalog.items as Obj[]).map((i) => {
          const l = links.find((x) => x.code === i.code);
          return { ...i, link_kind: l?.kind ?? "none", product_id: l?.product_id ?? null };
        });
        return this.send(res, 200, { ok: true, profile: { scale_key: job.scaleKey, ...(catalog.profile as Obj), active: true }, items });
      }
      case "save_branch_config":
        this.branchConfig = {
          prefix_length: args.config.prefixLength,
          plu_length: args.config.pluLength,
          weight_length: args.config.weightLength,
          weight_divisor: args.config.weightDivisor,
          total_length: args.config.totalLength,
          payload_type: args.config.payloadType,
        };
        return this.send(res, 200, { ok: true, result: null });
      case "save_scale_catalog":
        this.catalogs.set(job.scaleKey, { profile: args.profile, items: args.items });
        return this.send(res, 200, { ok: true, result: { items: (args.items ?? []).length, removed: 0 } });
      case "set_scale_links":
        this.links.set(job.scaleKey, args.links ?? []);
        return this.send(res, 200, { ok: true, result: null });
      case "set_scale_profile_active": {
        const s = this.scales.find((x) => x.key === job.scaleKey);
        if (s) s.active = args.active === true;
        return this.send(res, 200, { ok: true, result: null });
      }
      case "report":
        this.reports.push(args);
        return this.send(res, 200, { ok: true, result: "reporte" });
      default:
        return this.send(res, 400, { ok: false, error: "accion_invalida" });
    }
  }

  private canTake(conn: FakeConnector, job: FakeJob): boolean {
    return (
      job.status === "queued" &&
      job.company === conn.company &&
      (job.connectorId === conn.id || (job.connectorId === null && conn.scales.some((s) => s.key === job.scaleKey)))
    );
  }

  private pair(body: Obj, res: http.ServerResponse): void {
    const code = String(body.code ?? "").replace(/[\s-]/g, "").toUpperCase();
    const entry = this.codes.get(code);
    if (!entry || entry.used) return this.send(res, 400, { ok: false, error: "codigo_invalido" });
    const secret = randomBytes(32).toString("base64url");
    if (body.recover_id) {
      const c = this.connectors.get(body.recover_id);
      if (!c || c.company !== entry.company || c.revoked || c.fingerprint !== body.fingerprint) return this.send(res, 400, { ok: false, error: "no_se_puede_recuperar" });
      c.secret = secret;
      entry.used = true;
      return this.send(res, 200, { ok: true, connector_id: c.id, name: c.name, branch_id: "b1", recovered: true, secret });
    }
    const same = [...this.connectors.values()].filter((c) => c.company === entry.company && !c.revoked && body.fingerprint && c.fingerprint === body.fingerprint);
    if (same.length && !body.force_new) {
      return this.send(res, 409, { ok: false, error: "elegir", candidates: same.map((c) => ({ id: c.id, name: c.name, last_seen_at: null })) });
    }
    if ([...this.connectors.values()].some((c) => c.company === entry.company && !c.revoked && c.name.toLowerCase() === String(body.name).toLowerCase())) {
      return this.send(res, 400, { ok: false, error: "nombre_repetido" });
    }
    const id = randomUUID();
    this.connectors.set(id, { id, secret, company: entry.company, name: body.name, fingerprint: body.fingerprint ?? null, revoked: false, version: body.version ?? null, lastSeen: null, scales: [] });
    entry.used = true;
    this.send(res, 200, { ok: true, connector_id: id, name: body.name, branch_id: "b1", recovered: false, secret });
  }
}
