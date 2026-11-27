import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installFakeLocalStorage } from "../test-fake-storage";
import { buildSendJobResult } from "../job-log";
import { setScaleFrameTimeoutForTests } from "../../inventory/scale-serial";
import { barcodeOk, expectation, faultCatalog, FOREIGN, makeHarness, MODEL_LABEL, onScale, productProblemOnScale, scaleRecords, type Harness, type ModelId, type Variant } from "./test-envios-harness";
import { FAULT_KINDS, opClasses, type Fault, type FaultKind, type OpRecord } from "./test-scale-sims";
import type { PreparedSync, SyncOutcome } from "./types";

/**
 * [SIMULADO] INYECCIÓN DE FALLAS (B): un envío incompleto NUNCA se informa como exitoso.
 *
 * Para cada modelo se manda un catálogo chico (kilo, unidad, nombre largo con ñ, precio en el tope, uno ocupado por otro
 * producto) y la balanza simulada falla en la operación k, para TODA k del envío sin fallas (lecturas, escrituras,
 * relecturas y configuración del código de barras), con cada tipo de falla (sin respuesta, respuesta perdida, error,
 * "hecho" sin grabar, relectura distinta, corte). Se exige:
 * 1. Nunca "ok" si un producto pedido no quedó exacto en la balanza o el código de barras no quedó.
 * 2. Lo informado coincide con la balanza: cada producto que no figura como fallado está exacto en la balanza; los
 *    confirmados son exactamente los pedidos menos los fallados; los fallados son productos pedidos.
 * 3. Ningún producto ajeno (ni el ocupado) cambió; nada se escribió fuera del envío.
 * 4. El historial (job-log) dice lo mismo: "done" solo si ok, confirmados = verificados, fallados listados.
 * 5. sync nunca tira un error (se perdería qué quedó confirmado); prepare puede, pero sin haber escrito nada.
 *
 * Única excepción documentada: Kretz "hecho sin grabar" en el 1070. El protocolo Kretz no tiene cómo releer el 1070
 * (docs/AURA_INFORME_TECNICO.md: "Nx no tiene una lectura de 1070"), así que ese caso no se puede detectar sin hardware.
 */

const serial = Object.assign(new EventTarget(), { getPorts: async () => [], requestPort: async () => { throw new Error("no"); } });
Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true });
installFakeLocalStorage();
// La Report simulada contesta al instante: no hace falta esperar 2 s cada respuesta que no llega.
setScaleFrameTimeoutForTests(60);

const noop = () => {};
const V1: Variant = { v2: false, zone: false };

interface CaseResult {
  fault: Fault | null;
  op: OpRecord | null;
  violations: string[];
  ok: boolean;
}

let seq = 0;

type Extra = { sinc?: boolean; errorCode?: string };

async function runCase(model: ModelId, variant: Variant, fault: Fault | null, baselineOps: OpRecord[] = [], extra: Extra = {}): Promise<CaseResult> {
  const h = await makeHarness(model, variant, faultCatalog(model), { scaleKey: `balanza-${model}-${seq++}`, ...extra });
  const before = scaleRecords(h);
  h.setFault(fault);
  const v: string[] = [];
  const requested = h.engineProducts.filter((p) => expectation(model, p, h.catalog).kind === "send");
  let prepared: PreparedSync | null = null;
  let outcome: SyncOutcome | null = null;
  try {
    prepared = await h.session.prepare(noop);
  } catch {
    prepared = null;
  }
  if (prepared && !prepared.blocker && prepared.canWrite && !prepared.upToDate) {
    try {
      outcome = await h.session.sync(prepared, noop);
    } catch (err) {
      v.push(`sync tiró un error (se pierde qué quedó confirmado): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await h.session.close().catch(() => undefined);
  const after = scaleRecords(h);
  const correct = new Set(requested.filter((p) => productProblemOnScale(h, p) === null).map((p) => p.code));
  const barcode = barcodeOk(h);
  const limitation = !!fault && fault.kind === "ack_sin_grabar" && !!h.kretz && baselineOps[fault.at]?.command === "1070";

  // 3. Lo ajeno y lo ocupado intactos; nada escrito fuera del envío (salvo el producto de prueba de la Systel).
  const sendCodes = new Set(requested.map((p) => Number(p.code)));
  for (const n of FOREIGN) if (after.get(n) !== before.get(n)) v.push(`se pisó el producto ajeno ${n}`);
  for (const [n, raw] of after) {
    if (sendCodes.has(n) || raw === before.get(n)) continue;
    if (!h.kretz && onScale(h, n)?.name === "PRUEBA PATAGONIA") continue;
    v.push(`se escribió el ${n}, que no era del envío`);
  }

  if (!outcome) {
    // Sin resultado (prepare falló o frenó antes): no se escribió nada de los productos.
    for (const p of requested) if (after.get(Number(p.code)) !== before.get(Number(p.code))) v.push(`sin resultado pero el ${p.code} cambió en la balanza`);
    return { fault, op: fault ? baselineOps[fault.at] ?? null : null, violations: v, ok: false };
  }

  // 1. Nunca ok con algo sin quedar.
  if (outcome.ok) {
    const missing = requested.filter((p) => !correct.has(p.code)).map((p) => `${p.code}: ${productProblemOnScale(h, p)}`);
    if (missing.length) v.push(`OK pero no quedaron: ${missing.join(" | ")}`);
    if (!barcode && !limitation) v.push(`OK pero el código de barras no quedó (${JSON.stringify(h.kretz?.barcodeConfigs)})`);
  }
  // 2. Lo informado = la balanza.
  const failed = new Set((outcome.failures ?? []).map((f) => String(Number(f.code))));
  for (const code of failed) if (!sendCodes.has(Number(code))) v.push(`fallado informado que no era del envío: ${code}`);
  const reportedOk = requested.filter((p) => !failed.has(String(Number(p.code))));
  for (const p of reportedOk) if (!correct.has(p.code)) v.push(`informado como bien pero no quedó: ${p.code} (${productProblemOnScale(h, p)})`);
  if (outcome.verified !== reportedOk.length) v.push(`confirmados ${outcome.verified}, pero pedidos − fallados = ${reportedOk.length}`);
  // Con una sola falla (no un corte), a lo sumo UN producto puede quedar bien sin poder comprobarse (el que tocó la falla).
  if (fault && fault.kind !== "corte") {
    const falseFail = requested.filter((p) => failed.has(String(Number(p.code))) && correct.has(p.code));
    if (falseFail.length > 1) v.push(`informados como fallados pero están bien: ${falseFail.map((p) => p.code).join(",")}`);
  }
  // 4. Historial de envíos.
  const job = buildSendJobResult({ prepared: prepared!, outcome, products: h.engineProducts, requested: prepared!.writes, replace: false });
  if ((job.status === "done") !== outcome.ok) v.push(`historial "${job.status}" con ok=${outcome.ok}`);
  if (job.counters.confirmed !== outcome.verified) v.push(`historial: ${job.counters.confirmed} confirmados, motor ${outcome.verified}`);
  const jobFailed = new Set(job.items.filter((i) => i.status === "failed").map((i) => String(Number(i.plu))));
  if ([...failed].some((c) => !jobFailed.has(c)) || [...jobFailed].some((c) => !failed.has(c))) v.push(`historial: fallados ${[...jobFailed]} vs ${[...failed]}`);
  if (job.counters.requested !== requested.length) v.push(`historial: pedidos ${job.counters.requested}, eran ${requested.length}`);
  if (!outcome.ok && job.counters.confirmed + jobFailed.size !== requested.length && !(outcome.verified === requested.length)) {
    v.push(`historial: ${job.counters.confirmed} confirmados + ${jobFailed.size} fallados ≠ ${requested.length} pedidos`);
  }
  return { fault, op: fault ? baselineOps[fault.at] ?? null : null, violations: limitation && outcome.ok ? [] : v, ok: outcome.ok };
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/** Corre el envío sin fallas (debe salir bien) y después una falla en cada operación k, de cada tipo. */
async function sweep(model: ModelId, variant: Variant, concurrency: number, kinds: FaultKind[] = FAULT_KINDS, extra: Extra = {}) {
  // Envío limpio: tiene que salir bien y es la lista de operaciones a romper.
  const h = await makeHarness(model, variant, faultCatalog(model), { scaleKey: `balanza-${model}-base-${seq++}`, ...extra });
  const prep = await h.session.prepare(noop);
  const out = await h.session.sync(prep, noop);
  await h.session.close();
  assert.equal(out.ok, true, `${MODEL_LABEL[model]} sin fallas: ${out.message}`);
  const ops = (h.kretz ? h.kretz.ops : h.link!.ops).slice();
  const cases: Fault[] = [];
  for (let at = 0; at < ops.length; at++) for (const kind of kinds) cases.push({ at, kind });
  const results = await pool(cases, concurrency, (f) => runCase(model, variant, f, ops, extra));
  const bad = results.filter((r) => r.violations.length > 0);
  const notOk = results.filter((r) => !r.ok).length;
  const msg = bad.slice(0, 12).map((r) => `k=${r.fault!.at} (${r.op?.cls} ${r.op?.command}${r.op?.plu !== null ? ` PLU ${r.op?.plu}` : ""}) ${r.fault!.kind}: ${r.violations.join(" / ")}`).join("\n");
  return { ops, cases: results.length, bad, notOk, msg, classes: opClasses(ops) };
}

describe("[SIMULADO] Inyección de fallas: un envío incompleto nunca se informa como exitoso", () => {
  const models: { model: ModelId; concurrency: number }[] = [
    // La Report usa el puerto de scale-serial (uno solo por pestaña): de a uno.
    { model: "report-usb", concurrency: 1 },
    { model: "report-red", concurrency: 1 },
    { model: "aura", concurrency: 48 },
    { model: "max60", concurrency: 48 },
    { model: "max62", concurrency: 48 },
    { model: "max7", concurrency: 48 },
    { model: "cuora2", concurrency: 48 }
  ];
  for (const { model, concurrency } of models) {
    it(`${MODEL_LABEL[model]}: falla en cada operación k × ${FAULT_KINDS.length} tipos`, async (t) => {
      const r = await sweep(model, V1, concurrency);
      t.diagnostic(`${MODEL_LABEL[model]}: ${r.ops.length} operaciones (${JSON.stringify(r.classes)}) × ${FAULT_KINDS.length} = ${r.cases} casos; ${r.notOk} terminaron sin "ok"`);
      assert.equal(r.bad.length, 0, `${r.bad.length} de ${r.cases} casos con problemas:\n${r.msg}`);
    });
  }

  // 'balanzas_v2': el 1070 del perfil (Kretz) y el código propio con su inicio (Systel), con fallas en cada k.
  for (const model of ["report-usb", "aura", "max60"] as ModelId[]) {
    it(`${MODEL_LABEL[model]} con balanzas_v2: falla en cada operación k`, async (t) => {
      const r = await sweep(model, { v2: true, zone: false }, model === "report-usb" ? 1 : 48);
      t.diagnostic(`${MODEL_LABEL[model]} v2: ${r.ops.length} operaciones × ${FAULT_KINDS.length} = ${r.cases} casos`);
      assert.equal(r.bad.length, 0, `${r.bad.length} de ${r.cases} casos con problemas:\n${r.msg}`);
    });
  }

  // Systel: configuración (la balanza espera sincronización al encender: 35 N + relectura de la 39) y errores pasajeros
  // (E1: "llegó mal por el cable", que se reintentan) en cada operación.
  it("Systel Cuora Max 6.0 que espera sincronización (35 N y relectura): falla en cada operación k", async (t) => {
    const r = await sweep("max60", V1, 48, FAULT_KINDS, { sinc: true });
    t.diagnostic(`Cuora Max 6.0 con Sinc=1: ${r.ops.length} operaciones (${JSON.stringify(r.classes)}) × ${FAULT_KINDS.length} = ${r.cases} casos`);
    assert.ok(r.classes.configuracion >= 1, "hubo configuración (35 N)");
    assert.equal(r.bad.length, 0, `${r.bad.length} de ${r.cases} casos con problemas:
${r.msg}`);
  });
  for (const model of ["max60", "cuora2"] as ModelId[]) {
    it(`${MODEL_LABEL[model]}: error pasajero E1 en cada operación k (se reintenta)`, async (t) => {
      const r = await sweep(model, V1, 48, ["error"], { errorCode: "E1" });
      t.diagnostic(`${MODEL_LABEL[model]} E1: ${r.cases} casos; ${r.notOk} sin "ok"`);
      assert.equal(r.bad.length, 0, `${r.bad.length} de ${r.cases} casos con problemas:
${r.msg}`);
    });
  }

  // Límite del protocolo (no del código): el 1070 de las Kretz no se puede releer. Queda escrito acá para que se vea.
  it("LÍMITE CONOCIDO: una Kretz que contesta \"hecho\" al 1070 sin guardarlo no se puede detectar (Nx no tiene lectura del 1070)", async () => {
    const base = await sweep("report-usb", V1, 1, ["ack_sin_grabar"]);
    const k = base.ops.findIndex((o) => o.command === "1070");
    const r = await runCase("report-usb", V1, { at: k, kind: "ack_sin_grabar" }, base.ops);
    assert.equal(r.ok, true, "el motor lo da por bueno: depende de que la balanza real no mienta en el 1070");
  });
});
