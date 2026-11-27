import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installFakeLocalStorage } from "./test-fake-storage";
import type { EngineProduct, PreparedSync, SyncOutcome } from "./engine/types";

installFakeLocalStorage();

const { buildSendJobResult, finishScaleJob, isMissingFunction, jobDetail, startScaleJob, MAX_JOB_ITEMS } = await import("./job-log");
const { clearActivityLog, getActivityLog } = await import("./activity-log");
const { clearedInstallError, installSummary, newestInstall } = await import("./install-status");

const products: EngineProduct[] = [
  { id: "p-nalga", code: "1", name: "NALGA", unit: "kg", priceRetail: 18000 },
  { id: "p-vacio", code: "0037", name: "VACIO", unit: "kg", priceRetail: 15000 },
  { id: "p-pollo", code: "9", name: "POLLO", unit: "kg", priceRetail: 5200 }
];

const prepared = (extra: Partial<PreparedSync> = {}): PreparedSync => ({
  model: "kretz-report" as PreparedSync["model"],
  label: "Kretz Report",
  scaleProducts: 3,
  ready: 1,
  writes: 3,
  newLinks: 0,
  pending: [],
  priceDiffs: 0,
  canWrite: true,
  upToDate: false,
  notes: [],
  skipped: [{ code: "77", name: "SIN PRECIO", reason: "no tiene precio" }],
  ...extra
});

type Call = { fn: string; args: Record<string, unknown> };
function fakeRpc(reply: (fn: string) => { data: unknown; error: { code?: string; message?: string } | null } | Error) {
  const calls: Call[] = [];
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    const r = reply(fn);
    if (r instanceof Error) throw r;
    return r;
  };
  return { rpc, calls };
}

describe("historial de envíos: resultado por producto (lo que trae la sesión del motor)", () => {
  it("envío bueno: done, confirmados = verified, salteados del prepared, sin error", () => {
    const out: SyncOutcome = { ok: true, verified: 3, message: "Listo", pending: [] };
    const r = buildSendJobResult({ prepared: prepared(), outcome: out, products, requested: 3, replace: false });
    assert.equal(r.status, "done");
    assert.deepEqual(r.counters, { requested: 3, confirmed: 3, failed: 0, skipped: 1 });
    assert.equal(r.errorCode, null);
    assert.deepEqual(r.items, [{ product_id: null, plu: "77", action: "write", status: "skipped", reason: "no tiene precio", sent: null, read_back: null }]);
  });

  it("frenado a la mitad: partial, cada falla con su producto, motivo y lo que se mandó (nombre + precio)", () => {
    const out: SyncOutcome = {
      ok: false,
      verified: 1,
      message: "No quedaron todos",
      pending: [{ code: 9, scaleName: "POLLO ENTERO", byWeight: true, reason: "ocupado_en_balanza", detail: "en la balanza el 9 es \"POLLO ENTERO\"", suggestionId: null }],
      failures: [{ code: "37", name: "VACIO", reason: "la balanza no contestó al grabarlo" }],
      support: { etapa: "envio", stoppedAt: 37 }
    };
    const r = buildSendJobResult({ prepared: prepared(), outcome: out, products, requested: 3, replace: false });
    assert.equal(r.status, "partial");
    assert.deepEqual(r.counters, { requested: 3, confirmed: 1, failed: 1, skipped: 1 });
    assert.equal(r.errorCode, "envio");
    const failed = r.items.find((i) => i.status === "failed")!;
    // "37" en la balanza es el "0037" de Patagonia.
    assert.deepEqual(failed, { product_id: "p-vacio", plu: "37", action: "write", status: "failed", reason: "la balanza no contestó al grabarlo", sent: { name: "VACIO", price: 15000 }, read_back: null });
    const pending = r.items.find((i) => i.status === "pending")!;
    assert.equal(pending.action, "replace");
    assert.equal(pending.product_id, "p-pollo");
    assert.match(pending.reason!, /^ocupado_en_balanza: en la balanza el 9/);
  });

  it("frenado sin ningún confirmado ni lista de fallas: failed (nunca 0 fallas)", () => {
    const out: SyncOutcome = { ok: false, verified: 0, message: "frenado", pending: [], support: { verdict: "sin_respuesta" } };
    const r = buildSendJobResult({ prepared: prepared({ skipped: [] }), outcome: out, products, requested: 3, replace: false });
    assert.equal(r.status, "failed");
    assert.equal(r.counters.failed, 1);
    assert.equal(r.errorCode, "sin_respuesta");
  });

  it("el envío tiró un error (sin resultado): failed con el tipo de error", () => {
    const r = buildSendJobResult({ prepared: prepared(), outcome: null, products, requested: 3, replace: false, error: "no_contesta" });
    assert.equal(r.status, "failed");
    assert.deepEqual(r.counters, { requested: 3, confirmed: 0, failed: 3, skipped: 1 });
    assert.equal(r.errorCode, "no_contesta");
  });

  it("topes de la migración: hasta 10.000 productos y motivos de 300 letras", () => {
    const failures = Array.from({ length: MAX_JOB_ITEMS + 5 }, (_, i) => ({ code: String(i + 1), name: "X", reason: "x".repeat(400) }));
    const r = buildSendJobResult({ prepared: prepared({ skipped: [] }), outcome: { ok: false, verified: 0, message: "", pending: [], failures }, products, requested: 20000, replace: false });
    assert.equal(r.items.length, MAX_JOB_ITEMS);
    assert.equal(r.items[0].reason!.length, 300);
    assert.equal(r.counters.requested, MAX_JOB_ITEMS);
    assert.equal(r.counters.failed, MAX_JOB_ITEMS);
  });

  it("el detalle no pasa de ~30 KB: si el soporte es enorme, se manda sin él", () => {
    const big: SyncOutcome = { ok: false, verified: 0, message: "m", pending: [], support: { log: "x".repeat(40000) } };
    assert.equal("soporte" in jobDetail(prepared(), big), false);
    assert.equal("soporte" in jobDetail(prepared(), { ...big, support: { etapa: "envio" } }), true);
  });
});

describe("historial de envíos: registrar nunca frena el envío", () => {
  const ok = buildSendJobResult({ prepared: prepared(), outcome: { ok: true, verified: 3, message: "Listo", pending: [] }, products, requested: 3, replace: false });

  it("con la base al día: start y finish con los datos del envío", async () => {
    clearActivityLog();
    const { rpc, calls } = fakeRpc((fn) => ({ data: fn === "start_scale_job" ? "job-1" : { id: "job-1" }, error: null }));
    const job = startScaleJob(rpc, { branchId: "b1", scaleKey: "kretz-1", kind: "send", requested: 3, appVersion: "web-1" });
    assert.equal(await finishScaleJob(rpc, job, ok), true);
    assert.deepEqual(calls.map((c) => c.fn), ["start_scale_job", "finish_scale_job"]);
    assert.equal(calls[0].args.p_branch_id, "b1");
    assert.equal(calls[0].args.p_source, "web");
    assert.equal(calls[1].args.p_job_id, "job-1");
    assert.equal(calls[1].args.p_status, "done");
    assert.equal(getActivityLog().length, 0);
  });

  it("sin la migración 215 (función inexistente): no tira error ni llama a finish; queda en la bitácora local", async () => {
    clearActivityLog();
    const { rpc, calls } = fakeRpc(() => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.start_scale_job" } }));
    const job = startScaleJob(rpc, { branchId: "b1", scaleKey: "kretz-1", kind: "send", requested: 3, appVersion: null });
    assert.equal(await finishScaleJob(rpc, job, ok), false);
    assert.deepEqual(calls.map((c) => c.fn), ["start_scale_job"]);
    const log = getActivityLog();
    assert.equal(log.length, 1);
    assert.match(log[0].message, /sin registrar en la base · done: 3 confirmados/);
  });

  it("sin conexión (la llamada tira): no tira error; anota el inicio y el resultado en la bitácora local", async () => {
    clearActivityLog();
    const { rpc } = fakeRpc(() => new Error("Failed to fetch"));
    const job = startScaleJob(rpc, { branchId: "b1", scaleKey: "kretz-1", kind: "send", requested: 3, appVersion: null });
    assert.equal(await finishScaleJob(rpc, job, ok), false);
    assert.deepEqual(getActivityLog().map((e) => e.kind), ["sync", "sync"]);
    assert.match(getActivityLog()[0].message, /Failed to fetch/);
  });

  it("finish rechazado por la base: no tira error y queda en la bitácora local", async () => {
    clearActivityLog();
    const { rpc } = fakeRpc((fn) => (fn === "start_scale_job" ? { data: "job-2", error: null } : { data: null, error: { code: "P0001", message: "Ese envío ya está cerrado" } }));
    const job = startScaleJob(rpc, { branchId: "b1", scaleKey: "kretz-1", kind: "send", requested: 3, appVersion: null });
    assert.equal(await finishScaleJob(rpc, job, ok), false);
    assert.match(getActivityLog()[0].message, /ya está cerrado/);
  });

  it("modo demostración (sin base): solo la bitácora local", async () => {
    clearActivityLog();
    const job = startScaleJob(null, { branchId: "b1", scaleKey: "kretz-1", kind: "send", requested: 3, appVersion: null });
    assert.equal(await job.id, null);
    assert.equal(await finishScaleJob(null, job, ok), false);
    assert.equal(getActivityLog().length, 1);
  });

  it("reconoce la función inexistente por código o por texto", () => {
    assert.equal(isMissingFunction({ code: "PGRST202" }), true);
    assert.equal(isMissingFunction({ code: "42883", message: "function public.start_scale_job does not exist" }), true);
    assert.equal(isMissingFunction({ code: "P0001", message: "Sucursal inválida" }), false);
    assert.equal(isMissingFunction(null), false);
  });
});

describe("C17: un envío bueno limpia el error viejo de la instalación", () => {
  const error = { verifiedAt: "2026-11-26T10:00:00.000Z", communicationAt: "2026-11-26T10:00:00.000Z", failedCount: 1, lastError: "la balanza no contestó", lastErrorAt: "2026-11-26T10:05:00.000Z" };

  it("el envío bueno pisa el error, también contra la ficha de otra computadora que todavía lo tiene", () => {
    const at = "2026-11-26T11:00:00.000Z";
    const good = { ...error, verifiedAt: at, communicationAt: at, failedCount: 0, ...clearedInstallError(at) };
    const merged = newestInstall(error, good);
    assert.equal(merged.lastError, null);
    assert.equal(merged.lastErrorAt, at);
    assert.equal(newestInstall(good, error).lastError, null, "en cualquier orden");
    assert.doesNotMatch(installSummary(merged).text, /problemas/);
  });

  it("un error posterior al envío bueno se sigue mostrando", () => {
    const at = "2026-11-26T11:00:00.000Z";
    const later = { ...error, verifiedAt: at, communicationAt: at, failedCount: 0, lastError: "se desenchufó", lastErrorAt: "2026-11-26T11:30:00.000Z" };
    assert.equal(newestInstall({ ...error, ...clearedInstallError(at) }, later).lastError, "se desenchufó");
  });
});
