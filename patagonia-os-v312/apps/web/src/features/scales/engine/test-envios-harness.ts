import type { Product } from "@patagonia/domain";
import { buildAuraWriteRecord, auraWriteToReadOrder, parseAuraPlu } from "../../inventory/kretz/aura-plu";
import { auraName, readAuraList, runAuraSync } from "../../inventory/kretz/aura-sync";
import { expectedReportProduct, setScaleSerialPort, type ScaleSyncableProduct } from "../../inventory/scale-serial";
import { FakeCuora, fakeReadRecord } from "../../inventory/systel/systel-fake";
import { toCuoraText } from "../../inventory/systel/systel-frame";
import { parsePluAs, pluEanSetting, type SystelLayout } from "../../inventory/systel/systel-plu";
import { productPrice } from "../../pricing/price-lists";
import type { ScaleConfig } from "../../sale/scale-barcode";
import { resolveScaleLabel, type LabelContext } from "../../sale/scale-label-resolver";
import { activeLabelProfiles, isLabelSpec, kretz1070ForSpec, prefixesOverlap, specFromKretz1070, specPrefixes, specWithOwnPrefix, systelTicketCodes, type LabelSpec, type LabelSpecRow, type ScaleFamilyName } from "../label-spec";
import type { PrefixAllocation } from "../label-spec-service";
import type { ScaleCatalogItem, ScaleLink, ScaleSaleProfile } from "../sale/profile";
import type { ScaleSetup } from "../sale/scale-sale-service";
import { KRETZ_IO, KretzSession, type KretzIO } from "./adapters/kretz";
import { SystelSession, type SystelDeps } from "./adapters/systel";
import { FaultySystelLink, SimKretzScale, type Fault } from "./test-scale-sims";
import type { EngineContext, EngineProduct } from "./types";

/**
 * Armado común de la matriz de envíos y de la inyección de fallas (envios-matriz.test.ts, envios-fallas.test.ts).
 * Solo pruebas: no se usa en la app.
 *
 * Cada modelo es una balanza SIMULADA a nivel de protocolo (tramas Kretz, enlace Systel) con el motor de "Mi balanza"
 * tal cual (KretzSession / SystelSession, mismas funciones de scale-serial, aura-sync y systel-push que en producción).
 */

export type ModelId = "report-usb" | "report-red" | "aura" | "max60" | "max62" | "max7" | "cuora2";
export const MODELS: ModelId[] = ["report-usb", "report-red", "aura", "max60", "max62", "max7", "cuora2"];

export const MODEL_LABEL: Record<ModelId, string> = {
  "report-usb": "Kretz Report LT por USB",
  "report-red": "Kretz Report por red",
  aura: "Kretz Aura",
  max60: "Systel Cuora Max 6.0",
  max62: "Systel Cuora Max 6.2 (con centavos)",
  max7: "Systel Cuora Max 7.0",
  cuora2: "Systel Cuora 2"
};

const SYSTEL: Record<string, { layout: SystelLayout; protocol: string; capacity: number; decimals: number; extra: Record<string, unknown> }> = {
  max60: { layout: "max60", protocol: "0060", capacity: 8000, decimals: 0, extra: { typeByteAccepted: "ascii", loteNulOnWrite: true } },
  max62: { layout: "max62", protocol: "0062", capacity: 8000, decimals: 2, extra: {} },
  max7: { layout: "max7", protocol: "0070", capacity: 3000, decimals: 0, extra: { typeByteAccepted: "ascii", loteZerosOnWrite: true } },
  cuora2: { layout: "cuora2", protocol: "0040", capacity: 4000, decimals: 0, extra: {} }
};

export const isKretz = (m: ModelId) => m === "report-usb" || m === "report-red" || m === "aura";
export const priceDecimals = (m: ModelId) => (isKretz(m) ? 0 : SYSTEL[m].decimals);
/** Precio más alto que guarda el modelo (pesos). */
export const topPrice = (m: ModelId) => (priceDecimals(m) === 2 ? 9999.99 : 999999);
/** Código más alto que el modelo manda (número de la balanza y cifras de la etiqueta). */
export function topCode(m: ModelId): number {
  if (m === "report-usb" || m === "aura") return 999;
  if (m === "report-red") return 99999;
  if (m === "max60") return 8000;
  if (m === "cuora2") return 4000;
  return 9999; // max62 / max7: 4 cifras de producto en la etiqueta
}
/** Códigos que una Kretz usa para el TOTAL del ticket con 3 cifras de producto. */
const totalCodes = (m: ModelId) => (m === "report-usb" || m === "aura" ? [998, 999] : []);

export const ZONE = "z1";

export interface CatalogProduct extends EngineProduct {
  listPrices?: Record<string, { price: number }>;
}

/** Catálogo realista de una carnicería, con todos los casos de borde. */
export function fullCatalog(m: ModelId): CatalogProduct[] {
  const top = topPrice(m);
  const above = priceDecimals(m) === 2 ? 10000 : 1000000;
  // Una balanza con centavos guarda hasta $9.999,99: sus precios van ÷ 10 (con centavos de verdad).
  const k = priceDecimals(m) === 2 ? 0.1 : 1;
  const P = (id: string, code: string, name: string, unit: string, price: number, extra: Partial<CatalogProduct> = {}): CatalogProduct => ({ id, code, name, unit, priceRetail: price === top || price === above ? price : Math.round(price * k * 100) / 100, ...extra, ...(extra.listPrices ? { listPrices: { [ZONE]: { price: Math.round(extra.listPrices[ZONE].price * k * 100) / 100 } } } : {}) });
  return [
    P("vacio", "1", "Vacío", "kg", 15000),
    P("empanada", "7", "Empanada de carne", "unit", 1500),
    P("matambre", "123", "Matambre de cerdo", "kg", 12000),
    P("bondiola", "1234", "Bondiola", "kg", 13000),
    P("salame", "12345", "Salame tandilero", "unit", 5000),
    P("noquis", "42", "Ñoquis caseros con salsa de tomate y albahacá", "kg", 9900),
    P("hueso", "43", "Hueso para caldo", "kg", 1),
    P("chorizo", "44", "Chorizo especial", "unit", 1234.5),
    P("lomo", "45", "Lomo premium", "kg", top),
    P("lomo-extra", "46", "Lomo extra premium", "kg", above),
    P("p998", "998", "Producto 998", "kg", 1000),
    P("p999", "999", "Producto 999", "unit", 1000),
    P("p9998", "9998", "Producto 9998", "kg", 1000),
    P("bife-a", "60", "Bife angosto", "kg", 18000),
    P("bife-b", "60", "Bife ancho", "kg", 17000),
    P("sin-precio", "61", "Sin precio", "kg", 0),
    P("inactivo", "62", "Desactivado", "kg", 5000, { active: false }),
    P("asado", "70", "Asado", "kg", 16000),
    P("entrana", "80", "Entraña", "kg", 20000, { listPrices: { [ZONE]: { price: 22000 } } })
  ];
}

/** Catálogo chico para la inyección de fallas: kilo, unidad, nombre largo con ñ, precio en el tope, uno con centavos. */
export function faultCatalog(m: ModelId): CatalogProduct[] {
  const top = topPrice(m);
  return [
    { id: "vacio", code: "1", name: "Vacío", unit: "kg", priceRetail: 15000 },
    { id: "empanada", code: "7", name: "Empanada de carne", unit: "unit", priceRetail: 1500 },
    { id: "noquis", code: "42", name: "Ñoquis caseros con salsa de tomate", unit: "kg", priceRetail: 9900 },
    { id: "lomo", code: "45", name: "Lomo premium", unit: "kg", priceRetail: top },
    { id: "asado", code: "70", name: "Asado", unit: "kg", priceRetail: 16000 }
  ];
}

export type Expect = { kind: "send" } | { kind: "skip"; reason: RegExp } | { kind: "inactive" } | { kind: "occupied" };

/** Qué TIENE que pasar con cada producto en cada modelo (tabla propia, independiente de la revisión previa). */
export function expectation(m: ModelId, p: CatalogProduct, all: CatalogProduct[]): Expect {
  if (p.active === false) return { kind: "inactive" };
  const n = Number(p.code);
  if (n > topCode(m)) return { kind: "skip", reason: /código|cifras|número/ };
  if (totalCodes(m).includes(n)) return { kind: "skip", reason: /TOTAL/ };
  if (!(p.priceRetail > 0)) return { kind: "skip", reason: /precio/ };
  if (priceDecimals(m) === 0 && Math.round(p.priceRetail * 100) % 100 !== 0) return { kind: "skip", reason: /centavos/ };
  if (p.priceRetail > topPrice(m)) return { kind: "skip", reason: /más alto|no entra|fuera/ };
  if (all.filter((x) => x.code === p.code && x.active !== false).length > 1) return { kind: "skip", reason: new RegExp(`código ${p.code}|repetido`) };
  if (p.code === "70") return { kind: "occupied" };
  return { kind: "send" };
}

// ── Base en memoria con las reglas de la migración 222 (copiada de three-scales-e2e.test.ts) ───────────────────────

interface Row {
  key: string;
  family: ScaleFamilyName;
  totalFormat: string | null;
  spec: LabelSpec | null;
  history: { spec: LabelSpec; valid_until: string }[];
  prefixes: string[];
}

export class FakeBranchDb {
  rows: Row[] = [];
  register(key: string, family: ScaleFamilyName, spec: LabelSpec | null = null): void {
    this.rows.push({ key, family, totalFormat: null, spec, history: [], prefixes: spec ? specPrefixes(spec) : [] });
  }
  row(key: string): Row {
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
    for (const p of candidates) {
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

// ── Una balanza de cada modelo, lista para prepare → sync ─────────────────────────────────────────────────────────

export interface Variant {
  v2: boolean;
  zone: boolean;
}

export const SCALE_KEY = "balanza-prueba";
const BRANCH = "suc-1";
/** Productos que el cliente ya tiene en la balanza y no son de Patagonia (900) o que ocupan un número de Patagonia (70). */
export const FOREIGN = [900, 70];

const pad = (n: number, w: number) => String(Math.round(n)).padStart(w, "0");

function reportRecord(plu: number, name: string, byWeight: boolean, price: number): string {
  const t = (s: string, w: number) => s.padEnd(w, " ").slice(0, w);
  return [pad(plu, 6), "001", "001", t(name, 26), t("", 26), pad(plu, 5), byWeight ? "P" : "N", pad(0, 7), pad(price, 6), pad(0, 6), pad(2, 6), pad(0, 6), pad(0, 6), pad(0, 5), pad(0, 5), "01", pad(0, 4), pad(0, 4), pad(1000, 4), pad(0, 4)].join("");
}

export interface Harness {
  model: ModelId;
  scaleKey: string;
  variant: Variant;
  /** Todos los productos de Patagonia (con los desactivados). */
  catalog: CatalogProduct[];
  /** Lo que recibe el motor (con el precio de la zona, como Stock le pasa a "Mi balanza"). */
  engineProducts: EngineProduct[];
  db: FakeBranchDb;
  kretz: SimKretzScale | null;
  cuora: FakeCuora | null;
  link: FaultySystelLink | null;
  session: KretzSession | SystelSession;
  /** Formato de etiqueta que quedó guardado para Mostrador de la sucursal (Kretz sin 'balanzas_v2'). */
  branchConfig: { value: ScaleConfig | null };
  /** Lo que la Systel le dejó a Mostrador (catálogo + vínculos). */
  systelSetup: { value: ScaleSetup | null };
  setFault(f: Fault | null): void;
  ops(): number;
}

/** Arma la balanza simulada (con los productos ajenos) y la sesión del motor. `fresh` = clave de balanza única (Systel). */
export async function makeHarness(model: ModelId, variant: Variant, catalog: CatalogProduct[], opts: { scaleKey?: string; seedOther?: boolean; sinc?: boolean; errorCode?: string } = {}): Promise<Harness> {
  const scaleKey = opts.scaleKey ?? SCALE_KEY;
  const engineProducts: EngineProduct[] = catalog.map((p) => ({ id: p.id, code: p.code, name: p.name, unit: p.unit, priceRetail: variant.zone ? productPrice({ priceRetail: p.priceRetail, listPrices: p.listPrices as Product["listPrices"] }, ZONE) : p.priceRetail, active: p.active }));
  const db = new FakeBranchDb();
  const branchConfig: { value: ScaleConfig | null } = { value: null };
  const systelSetup: { value: ScaleSetup | null } = { value: null };
  // 'balanzas_v2': otra balanza del local ya tiene el inicio 20 → esta recibe uno propio. La Report por red conserva su
  // perfil 2-5-5 (lo cargó la migración 223 con lo que hace hoy).
  if (variant.v2) {
    if (model === "report-red") db.register(scaleKey, "kretz", specFromKretz1070("2112001"));
    else {
      if (opts.seedOther !== false) db.register("otra-balanza", "kretz", specWithOwnPrefix("kretz", "20"));
      db.register(scaleKey, isKretz(model) ? "kretz" : "systel");
    }
  }
  const ctx = (): EngineContext => ({ branchId: BRANCH, products: engineProducts, online: true, scaleKey, balanzasV2: variant.v2, labelSpec: variant.v2 ? db.row(scaleKey).spec : null });

  if (isKretz(model)) {
    const sim = new SimKretzScale(model === "aura" ? "aura" : "report");
    if (opts.errorCode) sim.errorCode = opts.errorCode;
    if (model === "aura") {
      sim.records.set(900, auraWriteToReadOrder(buildAuraWriteRecord({ plu: 900, name: "QUESO RALLADO", type: "D", code: 900, priceRaw: 8000 })));
      sim.records.set(70, auraWriteToReadOrder(buildAuraWriteRecord({ plu: 70, name: "QUESO CREMOSO", type: "D", code: 70, priceRaw: 9000 })));
    } else {
      sim.records.set(900, reportRecord(900, "QUESO RALLADO", true, 8000));
      sim.records.set(70, reportRecord(70, "QUESO CREMOSO", true, 9000));
    }
    const port = sim as unknown as SerialPort;
    const responder = { link: { baudRate: 9600, stopBits: 2 as const }, deviceType: "H", equipmentId: "01" };
    const base: KretzIO =
      model === "aura"
        ? {
            ...KRETZ_IO,
            readAuraList: ((onProgress: (t: string) => void) => readAuraList(port, responder, { timeoutMs: 40, onProgress })) as KretzIO["readAuraList"],
            runAuraSync: ((plan, onProgress, shouldStop, configureBarcode, barcodeConfig) => runAuraSync(port, responder, plan, { timeoutMs: 40, onProgress, shouldStop, configureBarcode, barcodeConfig })) as KretzIO["runAuraSync"]
          }
        : { ...KRETZ_IO };
    const io: KretzIO = {
      ...base,
      saveItemConfig: async (_b, config) => void (branchConfig.value = config ?? AURA_ITEM),
      loadBranchConfig: async () => branchConfig.value,
      ...(variant.v2 ? { allocatePrefix: db.allocate, saveLabelSpec: db.setSpec } : {})
    };
    if (model !== "aura") setScaleSerialPort(port);
    const session = new KretzSession(model === "aura" ? "kretz-aura" : "kretz-report-lt", ctx(), "datos", io, model === "report-red" ? { red: true } : {});
    return { model, scaleKey, variant, catalog, engineProducts, db, kretz: sim, cuora: null, link: null, session, branchConfig, systelSetup, setFault: (f) => void (sim.fault = f), ops: () => sim.ops.length };
  }

  const s = SYSTEL[model];
  const cuora = new FakeCuora(s.layout, { address: 20, protocol: s.protocol, capacity: s.capacity, decimals: s.decimals, ...s.extra });
  cuora.config = `Ton=2;Gris=0;Pap=0;Apa=1;Vel=5;Cpr=${s.decimals};Sinc=${opts.sinc ? 1 : 0};E_P=20PPPPIIIIII;E_U=21PPPPIIIIII;E_S=22AAIIIIIIII;Cim=1`;
  const raw = (pesos: number) => Math.round(pesos * 10 ** s.decimals);
  cuora.plus.set(900, fakeReadRecord(s.layout, { number: 900, name: "QUESO RALLADO", price: raw(8000), code: 900, type: "P" }));
  cuora.plus.set(70, fakeReadRecord(s.layout, { number: 70, name: "QUESO CREMOSO", price: raw(9000), code: 70, type: "P" }));
  const link = new FaultySystelLink(cuora);
  if (opts.errorCode) link.errorCode = opts.errorCode;
  let links: ScaleLink[] = [];
  const deps: SystelDeps = {
    loadSetup: async () => systelSetup.value,
    saveCatalog: async (_b, profile, catalog: ScaleCatalogItem[]) => {
      systelSetup.value = { profile: { ...(profile as Omit<ScaleSaleProfile, "catalog">), catalog }, links, readAt: null, repeatWindowMinutes: 3, active: true };
      if (variant.v2) db.row(scaleKey).totalFormat = profile.totalFormat;
    },
    setLinks: async (_b, _k, l) => {
      links = l;
      if (systelSetup.value) systelSetup.value = { ...systelSetup.value, links: l };
    },
    setActive: async () => {},
    saveLocalBackup: () => {},
    ...(variant.v2 ? { allocatePrefix: db.allocate } : {})
  };
  const session = new SystelSession(link, 20, ctx(), deps);
  return { model, scaleKey, variant, catalog, engineProducts, db, kretz: null, cuora, link, session, branchConfig, systelSetup, setFault: (f) => void (link.fault = f), ops: () => link.ops.length };
}

const AURA_ITEM: ScaleConfig = { prefixLength: 2, pluLength: 3, weightLength: 7, weightDivisor: 100, totalLength: 13, payloadType: "amount" };

// ── Qué quedó en la balanza ───────────────────────────────────────────────────────────────────────────────────────

export interface OnScale {
  name: string;
  /** En pesos. */
  price: number;
  byWeight: boolean;
  /** Código que va en la etiqueta. */
  code: number;
  /** Systel: código de barras del producto (tipo y formato). */
  ean: { type: number | null; config: string | null } | null;
  /** Report: el resto de los campos que importan (impuestos, decimales, etiqueta, vencimiento, descripción). */
  extrasOk: boolean;
  raw: string;
}

export function scaleRecords(h: Harness): Map<number, string> {
  return new Map(h.kretz ? h.kretz.records : h.cuora!.plus);
}

export function onScale(h: Harness, n: number): OnScale | null {
  if (h.kretz) {
    const r = h.kretz.records.get(n);
    if (!r) return null;
    if (h.model === "aura") {
      const p = parseAuraPlu(r);
      if (!p) return null;
      const cents = p.type === "P" || p.type === "N";
      return { name: p.name, price: cents ? Number(p.priceRaw) / 100 : Number(p.priceRaw), byWeight: p.type === "D" || p.type === "P", code: Number(r.slice(23, 28)), ean: null, extrasOk: !cents && p.validityDays === 0, raw: r };
    }
    const f = splitReport(r);
    const extrasOk = f[10] === "000002" && Number(f[11]) + Number(f[12]) === 0 && Number(f[7]) === 0 && f[4].trim() === "" && f[15] === "01";
    return { name: f[3].trimEnd(), price: Number(f[8]), byWeight: f[6] === "P", code: Number(f[5]), ean: null, extrasOk, raw: r };
  }
  const r = h.cuora!.plus.get(n);
  if (!r) return null;
  const s = SYSTEL[h.model];
  const p = parsePluAs(s.layout, r, n);
  if (!p) return null;
  return { name: p.name.trimEnd(), price: p.prices[0] / 10 ** s.decimals, byWeight: p.saleType === "P" || p.saleType === "C", code: p.code, ean: pluEanSetting(r, s.layout), extrasOk: p.expiryDays === 0, raw: r };
}

const REPORT_WIDTHS = [6, 3, 3, 26, 26, 5, 1, 7, 6, 6, 6, 6, 6, 5, 5, 2, 4, 4, 4, 4];
function splitReport(record: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (const w of REPORT_WIDTHS) {
    out.push(record.slice(i, i + w));
    i += w;
  }
  return out;
}

/** Cómo tiene que quedar el nombre en ESE modelo (cortado y sin tildes). */
export function expectedName(m: ModelId, name: string): string {
  if (m === "report-usb" || m === "report-red") return expectedReportProduct({ id: "x", code: "1", name, unit: "kg", priceRetail: 1 } as ScaleSyncableProduct).name;
  if (m === "aura") return auraName(name);
  return toCuoraText(name, 18).trimEnd();
}

export const NAME_LENGTH: Record<ModelId, number> = { "report-usb": 26, "report-red": 26, aura: 16, max60: 18, max62: 18, max7: 18, cuora2: 18 };

/** ¿El producto quedó exactamente como en Patagonia? null = sí; si no, en qué difiere. */
export function productProblemOnScale(h: Harness, p: EngineProduct): string | null {
  const got = onScale(h, Number(p.code));
  if (!got) return "no está en la balanza";
  const out: string[] = [];
  if (got.name !== expectedName(h.model, p.name)) out.push(`nombre "${got.name}" (esperado "${expectedName(h.model, p.name)}")`);
  if (Math.abs(got.price - p.priceRetail) > 1e-9) out.push(`precio ${got.price} (esperado ${p.priceRetail})`);
  if (got.byWeight !== (p.unit === "kg")) out.push(`${got.byWeight ? "por kilo" : "por unidad"}`);
  if (got.code !== Number(p.code)) out.push(`código de etiqueta ${got.code}`);
  if (!got.extrasOk) out.push("campos secundarios (impuesto, decimales, etiqueta o vencimiento)");
  const ean = expectedEan(h, p);
  if (ean && (got.ean?.type !== ean.type || got.ean?.config !== ean.config)) out.push(`código de barras ${JSON.stringify(got.ean)} (esperado ${JSON.stringify(ean)})`);
  return out.length ? out.join("; ") : null;
}

/** Systel: el código de barras propio que tiene que tener cada producto (null en Kretz). */
export function expectedEan(h: Harness, p: EngineProduct): { type: number; config: string | null } | null {
  if (h.kretz) return null;
  if (h.model === "cuora2") return { type: 0, config: null };
  const codes = systelTicketCodes(h.variant.v2 ? h.db.row(h.scaleKey).spec : null);
  return { type: 1, config: p.unit === "kg" ? codes.weighed : codes.unit };
}

/** Kretz: el 1070 que tiene que haber quedado en la balanza. */
export function expected1070(h: Harness): string | null {
  if (!h.kretz) return null;
  if (h.variant.v2) {
    const spec = h.db.row(h.scaleKey).spec;
    return spec ? kretz1070ForSpec(spec) : null;
  }
  return h.model === "report-red" ? "2112001" : "2002005";
}

/** ¿La configuración de código de barras quedó? (Kretz: el último 1070 recibido; Systel: va en cada producto). */
export function barcodeOk(h: Harness): boolean {
  if (!h.kretz) return true;
  const want = expected1070(h);
  return want !== null && h.kretz.barcodeConfigs[h.kretz.barcodeConfigs.length - 1] === want;
}

// ── El circuito completo: la etiqueta que imprimiría la balanza, leída por Mostrador ─────────────────────────────

const ean13 = (twelve: string) => {
  const d = twelve.split("").map(Number);
  const sum = d.reduce((acc, x, i) => acc + x * (i % 2 === 0 ? 1 : 3), 0);
  return twelve + String((10 - (sum % 10)) % 10);
};

/** Gramos (o unidades) a vender en la etiqueta de prueba, para que el valor entre en sus cifras sin redondeo. */
function pickQuantity(byWeight: boolean, price: number, fits: (grams: number) => boolean): number {
  if (!byWeight) return 2;
  for (const g of [1250, 1000, 500, 250, 100, 50, 20, 10]) if (fits(g)) return g;
  return 10;
}

/** La etiqueta que imprimiría la balanza para ese producto, con lo que TIENE GUARDADO (código, precio, formato). */
export function printedLabel(h: Harness, n: number): { raw: string; qty: number } | null {
  const s = onScale(h, n);
  if (!s) return null;
  if (h.kretz) {
    const c = h.kretz.barcodeConfigs[h.kretz.barcodeConfigs.length - 1];
    const m = c ? /^(2\d)([01])(2\d)([01])([15])$/.exec(c) : null;
    if (!m) return null;
    const [, wp, wt, up, ut, fmt] = m;
    const prefix = s.byWeight ? wp : up;
    const weightPayload = (s.byWeight ? wt : ut) === "1";
    const codeDigits = fmt === "5" ? 3 : 5;
    const valueDigits = fmt === "5" ? 7 : 5;
    const value = (g: number): number | null => {
      if (weightPayload) return g;
      const amount = s.price * (s.byWeight ? g / 1000 : g);
      // 2-3-7: importe en centavos; 2-5-5: importe en pesos enteros (real El Abastero: "19521" = $19.521).
      const v = fmt === "5" ? amount * 100 : amount;
      return Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : null;
    };
    const fits = (g: number) => {
      const v = value(g);
      return v !== null && String(v).length <= valueDigits;
    };
    const q = pickQuantity(s.byWeight, s.price, fits);
    const v = value(q);
    if (v === null || String(v).length > valueDigits || String(s.code).length > codeDigits) return null;
    return { raw: ean13(`${prefix}${pad(s.code, codeDigits)}${pad(v, valueDigits)}`), qty: s.byWeight ? q / 1000 : q };
  }
  const dec = SYSTEL[h.model].decimals;
  const template = s.ean?.type === 1 && s.ean.config ? s.ean.config : (s.byWeight ? h.cuora!.config!.match(/E_P=([^;]+)/)![1] : h.cuora!.config!.match(/E_U=([^;]+)/)![1]);
  const len = (ch: string) => (template.match(new RegExp(ch, "g")) ?? []).length;
  const fill = (g: number): string | null => {
    let out = "";
    let i = 0;
    const amount = Math.round(s.price * (s.byWeight ? g / 1000 : g) * 10 ** dec);
    while (i < template.length) {
      const ch = template[i];
      if (/\d/.test(ch)) {
        out += ch;
        i++;
        continue;
      }
      const w = len(ch);
      const val = ch === "P" ? s.code : ch === "C" ? g : ch === "I" ? amount : 0;
      if (String(val).length > w) return null;
      out += pad(val, w);
      i += w;
    }
    return out;
  };
  const q = pickQuantity(s.byWeight, s.price, (g) => fill(g) !== null && Math.abs(s.price * (s.byWeight ? g / 1000 : g) * 10 ** dec - Math.round(s.price * (s.byWeight ? g / 1000 : g) * 10 ** dec)) < 1e-6);
  const body = fill(q);
  return body ? { raw: ean13(body), qty: s.byWeight ? q / 1000 : q } : null;
}

export function mostradorContext(h: Harness): LabelContext {
  const products = h.catalog.map((p) => ({ ...p, cost: 0, stock: 0, minStock: 0, active: p.active ?? true }) as unknown as Product);
  const setups = h.systelSetup.value ? [h.systelSetup.value] : [];
  const kretzConfig = h.branchConfig.value;
  return {
    products,
    config: kretzConfig ?? AURA_ITEM,
    calibrated: !!kretzConfig,
    branchFormatCompetes: h.kretz ? undefined : false,
    setups,
    zoneListId: h.variant.zone ? ZONE : null,
    labelProfiles: h.variant.v2 ? { status: "ready", profiles: activeLabelProfiles(h.db.labelRows()) } : null
  };
}

/** Lee la etiqueta como Mostrador: devuelve producto, cantidad e importe, o el motivo por el que no la leyó. */
export function readAtCounter(h: Harness, raw: string): { productId: string; quantity: number; amount: number } | string {
  const ctx = mostradorContext(h);
  const r = resolveScaleLabel(raw, ctx);
  const price = (id: string) => {
    const p = h.catalog.find((x) => x.id === id)!;
    return h.variant.zone ? productPrice({ priceRetail: p.priceRetail, listPrices: p.listPrices as Product["listPrices"] }, ZONE) : p.priceRetail;
  };
  // Systel: Mostrador carga producto + cantidad (useScalePapers) y el renglón se cobra al precio del local (zona incluida).
  if (r.type === "systel") return { productId: r.product.id, quantity: r.quantity, amount: Math.round(r.quantity * price(r.product.id) * 100) / 100 };
  if (r.type === "scan" && r.resolution.type === "label") {
    const q = r.resolution.quantity;
    const amount = r.resolution.amount ?? Math.round(q * price(r.resolution.product.id) * 100) / 100;
    return { productId: r.resolution.product.id, quantity: q, amount };
  }
  return JSON.stringify(r).slice(0, 300);
}
