import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Product } from "@patagonia/domain";
import { installFakeLocalStorage } from "../test-fake-storage";
import { FakeReportScale } from "../../inventory/test-fake-report";
import { FakeCuora } from "../../inventory/systel/systel-fake";
import { pluEanSetting } from "../../inventory/systel/systel-plu";
import { KRETZ_IO, KretzSession, type KretzIO } from "../engine/adapters/kretz";
import { SystelSession, type SystelDeps } from "../engine/adapters/systel";
import type { EngineContext, EngineProduct } from "../engine/types";
import { activeLabelProfiles, isLabelSpec, prefixesOverlap, specPrefixes, specWithOwnPrefix, type LabelSpec, type LabelSpecRow, type ScaleFamilyName } from "../label-spec";
import type { PrefixAllocation } from "../label-spec-service";
import type { ScaleCatalogItem, ScaleLink, ScaleSaleProfile } from "./profile";
import type { ScaleSetup } from "./scale-sale-service";
import { resolveScaleLabel, type LabelContext } from "../../sale/scale-label-resolver";
import { validEan13 } from "../../sale/scan-resolve";

/**
 * [SIMULADO, de punta a punta] CASO CLAVE de 'balanzas_v2': un local con Kretz Report + Kretz Aura + Systel Cuora Max.
 * Las tres se registran y sincronizan en CUALQUIER orden (las 6), cada una recibe su inicio propio, y Mostrador lee bien
 * las etiquetas de las tres (y el TOTAL de la Aura) preguntándole a cada balanza.
 *
 * Simuladores: la Report de report-sync-e2e (tramas reales 2005/5005/1070 de scale-serial.ts, test-fake-report.ts), la
 * Cuora de los documentos de Systel (FakeCuora, escritura real 61/62 con el código propio por producto) y, para la
 * Aura, el doble de runAuraSync de engine.test.ts (aura-fake-device.ts es un capturador de iTegra: su relectura no es la
 * de una Aura real, así que no sirve para un envío completo). La base es un doble en memoria con las mismas reglas que
 * allocate_scale_prefix / set_scale_label_spec (la 222, probadas en SQL en tests/sql/222_scale_label_spec.sql).
 */

// ── Base en memoria: mismas reglas que la migración 222 ─────────────────────────────────────────────────────────
interface Row {
  key: string;
  family: ScaleFamilyName;
  totalFormat: string | null;
  spec: LabelSpec | null;
  history: { spec: LabelSpec; valid_until: string }[];
  prefixes: string[];
}

class FakeBranchDb {
  rows: Row[] = [];
  register(key: string, family: ScaleFamilyName) {
    this.rows.push({ key, family, totalFormat: null, spec: null, history: [], prefixes: [] });
  }
  private row(key: string): Row {
    return this.rows.find((r) => r.key === key)!;
  }
  private taken(key: string): string[] {
    const t = this.rows.filter((r) => r.key !== key).flatMap((r) => r.prefixes);
    if (this.rows.some((r) => r.key !== key && r.family === "systel")) t.push("22");
    return t;
  }
  private clash(spec: LabelSpec, taken: string[]): string | null {
    return specPrefixes(spec).find((p) => taken.some((t) => prefixesOverlap(p, t))) ?? null;
  }
  setSpec = async (_branch: string, key: string, spec: LabelSpec): Promise<LabelSpec> => {
    const c = this.clash(spec, this.rows.filter((r) => r.key !== key).flatMap((r) => r.prefixes));
    if (c) throw new Error(`El inicio de etiqueta ${c} ya lo usa otra balanza de este local`);
    const r = this.row(key);
    if (r.spec && JSON.stringify(r.spec) !== JSON.stringify(spec)) r.history.push({ spec: r.spec, valid_until: new Date(Date.now() + 7 * 86400000).toISOString() });
    r.spec = spec;
    r.prefixes = specPrefixes(spec);
    return spec;
  };
  allocate = async (branch: string, key: string): Promise<PrefixAllocation> => {
    const r = this.row(key);
    const taken = this.taken(key);
    if (r.spec && isLabelSpec(r.spec) && !this.clash(r.spec, taken)) {
      await this.setSpec(branch, key, r.spec);
      return { prefix: r.spec.prefixes.weighed ?? r.spec.prefixes.unit!, changed: false, spec: r.spec };
    }
    const candidates = r.family === "systel" ? ["20", "23", "24", "25", "26", "27", "28", "29"] : ["20", "23", "24", "25", "26", "27", "28", "29", "22"];
    for (const p of r.spec ? candidates.slice(1) : candidates) {
      const next = specWithOwnPrefix(r.family, p, r.totalFormat);
      if (this.clash(next, taken)) continue;
      const changed = JSON.stringify(r.spec) !== JSON.stringify(next);
      await this.setSpec(branch, key, next);
      return { prefix: p, changed, spec: next };
    }
    throw new Error("No queda ningún inicio de etiqueta libre en este local");
  };
  labelRows(): LabelSpecRow[] {
    return this.rows.map((r) => ({ scale_key: r.key, name: r.key, status: "active", label_spec: r.spec, label_spec_history: r.history }));
  }
}

// ── Productos del local (Patagonia: el número de la balanza es el código) ──────────────────────────────────────
const P = (id: string, code: string, name: string, unit: string, priceRetail: number): EngineProduct => ({ id, code, name, unit, priceRetail });
const ENGINE_PRODUCTS = [P("vacio", "10", "VACIO", "kg", 15000), P("matambre", "11", "MATAMBRE", "kg", 12000), P("empanada", "50", "EMPANADA", "unit", 1500)];
const PRODUCTS = ENGINE_PRODUCTS.map((p) => ({ ...p, cost: 0, stock: 0, minStock: 0, active: true }) as unknown as Product);

const ean = (twelve: string) => {
  const d = twelve.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return twelve + String((10 - (sum % 10)) % 10);
};
const pad = (n: number, w: number) => String(n).padStart(w, "0");

// ── Las tres balanzas ───────────────────────────────────────────────────────────────────────────────────────
const serial = Object.assign(new EventTarget(), { getPorts: async () => [], requestPort: async () => { throw new Error("no"); } });
Object.defineProperty(globalThis, "navigator", { value: { serial }, configurable: true });

const ctxFor = (db: FakeBranchDb, key: string): EngineContext => ({ branchId: "suc-1", products: ENGINE_PRODUCTS, online: true, scaleKey: key, balanzasV2: true, labelSpec: db.rows.find((r) => r.key === key)!.spec });
const noop = () => {};

async function syncReport(db: FakeBranchDb): Promise<FakeReportScale> {
  const scale = new FakeReportScale();
  const { setScaleSerialPort } = await import("../../inventory/scale-serial");
  setScaleSerialPort(scale as unknown as SerialPort);
  const io: KretzIO = { ...KRETZ_IO, allocatePrefix: db.allocate, saveLabelSpec: db.setSpec };
  const s = new KretzSession("kretz-report-lt", ctxFor(db, "report"), "datos", io);
  const out = await s.sync(await s.prepare(noop), noop);
  assert.equal(out.ok, true, `Report: ${out.message} ${JSON.stringify(out.support)}`);
  return scale;
}

async function syncAura(db: FakeBranchDb): Promise<string[]> {
  const sent: string[] = [];
  const io: KretzIO = {
    ...KRETZ_IO,
    readAuraList: (async () => ({ records: [], complete: true, detail: "", exchanges: [] })) as unknown as KretzIO["readAuraList"],
    runAuraSync: (async (plan: { plu: number | null; action: string }[], _p: unknown, _s: unknown, _c: unknown, barcodeConfig?: string) => {
      sent.push(barcodeConfig ?? "2002005");
      const todo = plan.filter((x) => ["crear", "actualizar", "reemplazar"].includes(x.action));
      return { verdict: "ok", detail: "", written: todo.map((x) => ({ plu: x.plu, action: x.action })), stoppedAt: null, barcode: "ok", before: [], after: [], exchanges: [], openLog: [], startedAt: "", finishedAt: "" };
    }) as unknown as KretzIO["runAuraSync"],
    allocatePrefix: db.allocate,
    saveLabelSpec: db.setSpec
  };
  const s = new KretzSession("kretz-aura", ctxFor(db, "aura"), "datos", io);
  const out = await s.sync(await s.prepare(noop), noop);
  assert.equal(out.ok, true, `Aura: ${out.message} ${JSON.stringify(out.support)}`);
  return sent;
}

// Dos productos REALES de una Cuora Max 6.0 (Los gringos, engine.test.ts) para que la balanza tenga de dónde copiar.
const T1 = "\u0001";
const Z = "0".repeat(56);
const CUORA_SEED: [number, string][] = [
  [1, `00010ALPINA CAJON DE   08200007800000001010000U00000000N                              ${Z}${T1}000000000000N`],
  [4, `00040POLLO ENTEROxKG   00520000000000004010000P00000000N                              ${Z}${T1}000000000000N`]
];

async function syncSystel(db: FakeBranchDb): Promise<{ cuora: FakeCuora; setup: ScaleSetup }> {
  const cuora = new FakeCuora("max60", { address: 20, protocol: "0060", typeByteAccepted: "ascii", loteNulOnWrite: true });
  cuora.config = "Ton=2;Gris=0;Pap=0;Apa=1;Vel=5;Cpr=0;Sinc=0;E_P=20PPPPIIIIII;E_U=21PPPPIIIIII;E_S=22AAIIIIIIII;Cim=1";
  for (const [n, raw] of CUORA_SEED) cuora.plus.set(n, raw);
  let setup: ScaleSetup | null = null;
  let links: ScaleLink[] = [];
  const deps: SystelDeps = {
    loadSetup: async () => null,
    saveCatalog: async (_b, profile, catalog: ScaleCatalogItem[]) => {
      setup = { profile: { ...(profile as Omit<ScaleSaleProfile, "catalog">), catalog }, links: [], readAt: null, repeatWindowMinutes: 3, active: true };
      db.rows.find((r) => r.key === "systel")!.totalFormat = profile.totalFormat;
    },
    setLinks: async (_b, _k, l) => void (links = l),
    setActive: async () => {},
    saveLocalBackup: () => {},
    forceWritable: true,
    allocatePrefix: db.allocate
  };
  const s = new SystelSession(cuora, 20, ctxFor(db, "systel"), deps);
  const out = await s.sync(await s.prepare(noop), noop);
  assert.equal(out.ok, true, `Systel: ${out.message} ${JSON.stringify(out.support)}`);
  assert.ok(setup, "la Systel guardó su catálogo para Mostrador");
  return { cuora, setup: { ...setup!, links } };
}

const ORDERS: ("report" | "aura" | "systel")[][] = [
  ["report", "aura", "systel"],
  ["report", "systel", "aura"],
  ["aura", "report", "systel"],
  ["aura", "systel", "report"],
  ["systel", "report", "aura"],
  ["systel", "aura", "report"]
];

beforeEach(() => installFakeLocalStorage());

describe("[SIMULADO] Un local con Kretz Report + Kretz Aura + Systel Cuora Max ('balanzas_v2')", () => {
  for (const order of ORDERS) {
    it(`sincronizan en el orden ${order.join(" → ")} y Mostrador lee las etiquetas de las tres`, async () => {
      const db = new FakeBranchDb();
      let report: FakeReportScale | null = null;
      let auraSent: string[] = [];
      let systel: { cuora: FakeCuora; setup: ScaleSetup } | null = null;
      // Cada una se registra (Mis balanzas) y se sincroniza, en ese orden.
      for (const which of order) {
        db.register(which, which === "systel" ? "systel" : "kretz");
        if (which === "report") report = await syncReport(db);
        else if (which === "aura") auraSent = await syncAura(db);
        else systel = await syncSystel(db);
      }
      const spec = (k: string) => db.rows.find((r) => r.key === k)!.spec!;

      // 1. Inicios: distintos y que no se pisan; la primera conserva el de siempre (20).
      const all = db.rows.map((r) => r.prefixes);
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        assert.ok(!all[i].some((a) => all[j].some((b) => prefixesOverlap(a, b))), `inicios pisados: ${JSON.stringify(all)}`);
      }
      assert.equal(spec(order[0]).prefixes.weighed, "20", "la primera balanza conserva el inicio de siempre");
      assert.ok(!["report", "aura"].some((k) => spec(k).prefixes.weighed === "22"), "ninguna Kretz recibe el 22 (el TOTAL de la Cuora), aunque la Systel se registre después");

      // 2. Cada balanza recibió SU perfil: el 1070 de cada Kretz y el código propio de cada producto de la Systel.
      const reportPrefix = spec("report").prefixes.weighed!;
      const auraPrefix = spec("aura").prefixes.weighed!;
      const systelPrefix = spec("systel").prefixes.weighed!;
      assert.deepEqual(report!.barcodeConfigs, [`${reportPrefix}0${reportPrefix}05`]);
      assert.deepEqual(auraSent, [`${auraPrefix}0${auraPrefix}05`]);
      const systelUnit = spec("systel").prefixes.unit!;
      assert.equal(pluEanSetting(systel!.cuora.plus.get(10)!).config, `${systelPrefix}PPPPCCCCCC`);
      assert.equal(pluEanSetting(systel!.cuora.plus.get(50)!).config, `${systelUnit}PPPPCCCCCC`);

      // 3. Mostrador, con los perfiles de la base (y las balanzas Systel de la sucursal, como hoy).
      const ctx: LabelContext = {
        products: PRODUCTS,
        config: { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" },
        calibrated: true,
        setups: [systel!.setup],
        labelProfiles: { status: "ready", profiles: activeLabelProfiles(db.labelRows()) }
      };
      const read = (raw: string) => {
        assert.ok(validEan13(raw), raw);
        return resolveScaleLabel(raw, ctx);
      };
      // Report y Aura: VACIO 1,250 kg = $18.750 (2-3-7 en centavos), cada una con su inicio.
      for (const prefix of [reportPrefix, auraPrefix]) {
        const r = read(ean(`${prefix}010${pad(1875000, 7)}`));
        assert.equal(r.type, "scan", `${prefix}: ${JSON.stringify(r)}`);
        if (r.type !== "scan" || r.resolution.type !== "label") throw new Error(`${prefix}: no es una etiqueta`);
        assert.equal(r.resolution.product.code, "10");
        assert.equal(r.resolution.quantity, 1.25);
        assert.equal(r.resolution.amount, 18750);
      }
      // TOTAL del ticket de la Aura (código 998) con su inicio: un total, nunca un producto.
      const total = read(ean(`${auraPrefix}998${pad(4210050, 7)}`));
      assert.ok(total.type === "scan" && total.resolution.type === "ticket_total" && total.resolution.amount === 42100.5, JSON.stringify(total));
      // Systel: MATAMBRE 0,875 kg (producto 4 cifras + gramos 6) y 2 EMPANADAS, con su inicio.
      const kg = read(ean(`${systelPrefix}0011000875`));
      assert.ok(kg.type === "systel" && kg.product.code === "11" && kg.quantity === 0.875, JSON.stringify(kg));
      const units = read(ean(`${systelUnit}0050000002`));
      assert.ok(units.type === "systel" && units.product.code === "50" && units.quantity === 2, JSON.stringify(units));
      // El TOTAL de la Systel ("22…") nunca se cobra solo como un producto de otra balanza.
      const systelTotal = read(ean(`2202${pad(41250, 8)}`));
      assert.ok(systelTotal.type === "systel_message" || systelTotal.type === "ambiguous", JSON.stringify(systelTotal));
    });
  }

  it("una etiqueta vieja (perfil anterior, 7 días) que coincide con otra lectura distinta: ambigua, no se cobra", async () => {
    const db = new FakeBranchDb();
    db.register("report", "kretz");
    db.register("aura", "kretz");
    await db.allocate("suc-1", "report"); // 20
    // La Aura imprimía con 20 en pesos (2-5-5) antes; ahora recibe su inicio propio y el perfil viejo queda vigente.
    db.rows[1].spec = { v: 1, prefixes: { weighed: "20", unit: "20", total: "20" }, layout: { prefix: 1, code: 6, value: 5, length: 13, divisor: 1 }, value: "amount_pesos", sumCode: 99998, writer: { kind: "kretz1070", code: "2002001" } };
    const a = await db.allocate("suc-1", "aura");
    assert.equal(a.prefix, "23");
    const ctx: LabelContext = { products: PRODUCTS, config: { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" }, calibrated: true, setups: [], labelProfiles: { status: "ready", profiles: activeLabelProfiles(db.labelRows()) } };
    // "20 010 1500000": la Report dice VACIO $15.000 (1 kg); el perfil viejo de la Aura dice producto 101 (no existe) → una sola.
    const one = resolveScaleLabel(ean(`20010${pad(1500000, 7)}`), ctx);
    assert.ok(one.type === "scan" && one.resolution.type === "label" && one.resolution.quantity === 1, JSON.stringify(one));
    // "2 000011 18000": la Report lee producto 0 (nada); la Aura vieja lee MATAMBRE $18.000 → una sola (la vieja).
    const old = resolveScaleLabel(ean(`2000011${pad(18000, 5)}`), ctx);
    assert.ok(old.type === "scan" && old.resolution.type === "label" && old.resolution.product.code === "11", JSON.stringify(old));
    // "20 010 0015000": la Report lee VACIO $150; la Aura vieja lee el producto 1000 por $15.000 → dos cobrables: ambigua.
    const extra = [...PRODUCTS, { ...PRODUCTS[0], id: "p1000", code: "1000", name: "ENTRAÑA" }];
    const amb = resolveScaleLabel(ean("200100015000"), { ...ctx, products: extra });
    assert.equal(amb.type, "ambiguous", JSON.stringify(amb));
  });
});
