import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { installFakeLocalStorage } from "../test-fake-storage";
import { applySameScaleAnswer, connectBranchScale } from "../engine/connect-branch";
import type { EngineContext, ScaleAdapter, ScaleSession } from "../engine/types";
import { lastUseText, sameScaleCandidates, type BranchScale } from "./scale-identity";

/**
 * C22 (plan balanzas v2): en producción la misma balanza quedó registrada varias veces (4 × {"address":20},
 * 2 × {"letter":"C","equipment":"01"}): "Agregar balanza" registraba SIEMPRE otra, aunque se pareciera a una ya
 * registrada. Ahora, si se parece, se pregunta "¿Es la Balanza X?" y solo con "No, es otra balanza" se registra nueva.
 */

beforeEach(() => installFakeLocalStorage());

const noop = () => {};
const ctx = (): EngineContext => ({ branchId: "b1", products: [], online: false });
const scale = (key: string, family: "systel" | "kretz", identity: Record<string, unknown>, extra: Partial<BranchScale> = {}): BranchScale => ({
  key,
  name: extra.name ?? key,
  family,
  brand: family,
  model: null,
  identity,
  active: true,
  lastSeenAt: extra.lastSeenAt ?? null,
  sellsWithCodes: false,
  ...extra
});

/** Una balanza de mentira por cable: contesta siempre con esa identidad. */
function plugged(family: "systel" | "kretz", identity: Record<string, unknown>) {
  const port = { getInfo: () => ({ usbVendorId: family === "systel" ? 0x0403 : 0x1a86, usbProductId: 0x6001 }) } as unknown as SerialPort;
  const adapter: ScaleAdapter = {
    family,
    identify: async () =>
      ({
        model: `${family}-x`,
        label: family === "systel" ? "Systel Cuora Max" : "Kretz Report",
        identity: () => ({ ...identity }),
        close: async () => {},
        prepare: async () => ({}) as never,
        sync: async () => ({}) as never,
        supportInfo: () => ({})
      }) as ScaleSession
  };
  return { serial: { getPorts: async () => [port], requestPort: async () => port }, adapters: [adapter] };
}

describe("¿es la misma balanza? (C22)", () => {
  it("candidatas: misma marca e identidad (o registrada sin identidad), la usada más recientemente primero", () => {
    const known = [
      scale("s1", "systel", { address: 20 }, { name: "Balanza 1", lastSeenAt: "2026-11-01T10:00:00Z" }),
      scale("s2", "systel", { address: 20 }, { name: "Balanza 2", lastSeenAt: "2026-11-20T10:00:00Z" }),
      scale("s3", "systel", { address: 21 }, { name: "Otra número" }),
      scale("s4", "systel", {}, { name: "De antes" }),
      scale("k1", "kretz", { letter: "C", equipment: "01" })
    ];
    assert.deepEqual(
      sameScaleCandidates(known, "systel", { address: 20 }).map((c) => c.key),
      ["s2", "s1", "s4"]
    );
    assert.deepEqual(sameScaleCandidates(known, "kretz", { letter: "C", equipment: "01" }), [{ key: "k1", name: "k1", lastSeenAt: null }]);
    assert.deepEqual(sameScaleCandidates(known, "kretz", { letter: "D", equipment: "01" }), []);
  });

  it("agregar una que se parece: NO la registra sola, devuelve la pregunta con nombre y último uso", async () => {
    const known = [scale("kretz-83195082", "kretz", { letter: "C", equipment: "01" }, { name: "Balanza Kretz", lastSeenAt: "2026-11-20T13:00:00Z" })];
    const d = plugged("kretz", { letter: "C", equipment: "01" });
    const r = await connectBranchScale(ctx(), noop, { target: null, known, pick: true }, d);
    assert.equal(r.matched, null);
    assert.deepEqual(r.sameAsk, { candidates: [{ key: "kretz-83195082", name: "Balanza Kretz", lastSeenAt: "2026-11-20T13:00:00Z" }] });
  });

  it("sin parecidas, o reconectando una registrada: sin pregunta (como siempre)", async () => {
    const known = [scale("s1", "systel", { address: 20 })];
    const nueva = await connectBranchScale(ctx(), noop, { target: null, known, pick: true }, plugged("systel", { address: 21 }));
    assert.equal(nueva.sameAsk, null);
    const misma = await connectBranchScale(ctx(), noop, { target: known[0], known, pick: true }, plugged("systel", { address: 20 }));
    assert.equal(misma.sameAsk, null);
    assert.equal(misma.matched?.key, "s1");
  });

  it("'Sí, es esa' la toma como la registrada; 'No, es otra balanza' la deja como nueva", async () => {
    const known = [scale("s1", "systel", { address: 20 }, { name: "Mostrador" })];
    const r = await connectBranchScale(ctx(), noop, { target: null, known, pick: true }, plugged("systel", { address: 20 }));
    const si = applySameScaleAnswer(r, known, "s1");
    assert.equal(si.matched?.key, "s1");
    assert.equal(si.lookalike, null);
    assert.equal(si.sameAsk, null);
    assert.ok(si.diag.steps.some((x) => /es la misma que s1/.test(x)));
    const no = applySameScaleAnswer(r, known, null);
    assert.equal(no.matched, null);
    assert.equal(no.sameAsk, null);
    assert.equal(no.lookalike?.key, "s1", "sigue el aviso de que se parece");
    assert.equal(applySameScaleAnswer(r, known, "no-existe").matched, null, "una clave que no está: nueva");
  });

  it("conectar la misma balanza 3 veces → un solo registro", async () => {
    const registry: BranchScale[] = [];
    for (let i = 0; i < 3; i++) {
      let r = await connectBranchScale(ctx(), noop, { target: null, known: registry, pick: true }, plugged("systel", { address: 20 }));
      if (r.sameAsk) r = applySameScaleAnswer(r, registry, r.sameAsk.candidates[0].key); // la persona: "Sí, es esa"
      if (!r.matched) registry.push(scale(`s${registry.length + 1}`, r.family, r.identity));
    }
    assert.equal(registry.length, 1);
  });

  it("último uso en palabras", () => {
    const now = new Date("2026-11-26T15:00:00-03:00");
    assert.equal(lastUseText(null, now), "nunca se conectó");
    assert.match(lastUseText("2026-11-26T12:30:00-03:00", now), /^usada hoy/);
    assert.match(lastUseText("2026-11-20T12:30:00-03:00", now), /^usada el 20\/11/);
  });
});
