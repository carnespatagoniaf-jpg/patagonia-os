// Nube simulada para las pruebas: un servidor HTTP en 127.0.0.1 que imita scale-connect-pair y
// scale-connect-api (mismas rutas, encabezado, códigos HTTP y reglas que la migración 226), en memoria.
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
  scales: Array<{ key: string; name: string; online: boolean }>;
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
        return this.send(res, 200, { ok: true, result: { id: job.id, status: job.status } });
      }
      case "config":
        return this.send(res, 200, { ok: true, connector: { id: conn.id, name: conn.name, branch_id: "b1" }, company_name: `Carnicería ${conn.company}`, branch_name: "Centro", scales: [{ key: "kretz-1", name: "Report" }] });
      default:
        return this.send(res, 404, { ok: false, error: "no_existe" });
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
