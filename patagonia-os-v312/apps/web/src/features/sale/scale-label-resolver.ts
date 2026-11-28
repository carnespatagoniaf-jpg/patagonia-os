import type { Product } from "@patagonia/domain";
import { productPrice } from "../pricing/price-lists";
import { formatMoney } from "../shifts/format";
import { decodeAcross } from "../scales/sale/multi-decode";
import { addScannedItem, describeItem, emptyPaper } from "../scales/sale/paper";
import type { ScaleSetup } from "../scales/sale/scale-sale-service";
import type { ScaleConfig } from "./scale-barcode";
import { isScaleConfigUnknown, SCALE_CONFIG_LOADING_MESSAGE, SCALE_CONFIG_UNKNOWN_MESSAGE, type ScaleConfigStatus } from "./scale-config-cache";
import { scanChoiceOptions, type LabelChoiceOption } from "./scale-label-choice";
import { labelWeightProblem, MAX_COUNTER_SCALE_KG, resolveScan, type ScanChoice, type ScanResolution } from "./scan-resolve";
import { resolveScanByProfiles } from "./scale-profile-scan";
import type { ScaleLabelProfile } from "../scales/label-spec";

/**
 * Resolvedor ÚNICO de etiquetas de balanza (C3/C4, auditoría 26/11). Lo usan Mostrador y Clientes ("Venta a cuenta").
 *
 * Junta las lecturas posibles de un código:
 * - la de las balanzas "artículos + TOTAL" de la sucursal (perfiles Systel, scale_profiles);
 * - la del formato de etiquetas de la sucursal y las lecturas Kretz (resolveScan, con la regla C2 del 998/999).
 *
 * REGLA DE ORO: una etiqueta se cobra solo si hay UNA lectura posible. Con dos lecturas válidas distintas no se agrega
 * nada: se devuelven las opciones (nombre, kilos, importe) para que la persona elija o cargue a mano.
 *
 * Cuándo cuenta cada lectura:
 * - Systel: solo si el número está en el catálogo o en los vínculos de esa balanza y el peso lo puede pesar una balanza
 *   de mostrador (hasta 31 kg). Si no, esa lectura no existe (una etiqueta Kretz "20…" tiene la misma forma).
 * - Formato de la sucursal: compite con una lectura Systel válida solo si la sucursal tiene su formato CALIBRADO (el de
 *   fábrica no prueba que haya una Kretz; así un local que solo tiene Systel sigue como siempre).
 *
 * Puro: sin pantallas ni Supabase (scale-label-resolver.test.ts).
 */

export interface LabelContext {
  products: Product[];
  /** Formato de etiquetas de la sucursal (o el que informó la Systel del piloto). */
  config: ScaleConfig;
  /** true = la sucursal tiene un formato guardado (no el de fábrica). */
  calibrated: boolean;
  /**
   * false = todas las balanzas registradas y activas de la sucursal son Systel: el formato de la sucursal es un resto de
   * antes (real: Carnes premium, El Dorado, Los gringos, mercadito isabel y Pollo Pampa tienen uno guardado) y NO compite
   * con una lectura Systel válida; solo se usa si la Systel no reconoce la etiqueta. Sin el dato (undefined) compite,
   * que es lo seguro: ante la duda, preguntar.
   */
  branchFormatCompetes?: boolean;
  /** Balanzas "artículos + TOTAL" activas de la sucursal. */
  setups: ScaleSetup[];
  /**
   * Zona de precios del local (migración 192): la balanza del local tiene ESOS precios (Stock le manda los de la zona),
   * así que los kilos de una etiqueta con importe salen de ahí, en Mostrador y en Clientes (C4). null = precio general.
   */
  zoneListId?: string | null;
  /**
   * C5: "loading" = todavía no llegó el formato de la base ni hay copia en esta PC; "unknown" = no se pudo cargar y no
   * hay copia. En los dos casos no se lee NINGUNA etiqueta (tampoco los TOTAL ni las lecturas Kretz fijas).
   * Sin el dato, se deduce del formato (SCALE_CONFIG_UNKNOWN = desconocido).
   */
  configStatus?: ScaleConfigStatus;
  /**
   * 'balanzas_v2' (interruptor por empresa): los perfiles de etiqueta de cada balanza activa de la sucursal (+ los
   * anteriores vigentes). Con esto, cada etiqueta se le pregunta a cada balanza (scale-profile-scan.ts) en vez de leerse
   * con el formato de la sucursal y las listas por cliente. Sin esto (interruptor apagado), todo como antes.
   * status "loading"/"unknown": no se leen etiquetas (igual que C5).
   */
  labelProfiles?: { status: ScaleConfigStatus; profiles: ScaleLabelProfile[] } | null;
}

/** Precio con el que imprimió la balanza del local: el de la zona si tiene, si no el general. */
export function scalePrintedPrice(product: Pick<Product, "priceRetail" | "listPrices">, zoneListId: string | null | undefined): number {
  return productPrice(product, zoneListId);
}

export type SystelReading =
  | { kind: "not_scale" }
  /** No cuenta como lectura (número que esa balanza no tiene, código mal leído, peso imposible). */
  | { kind: "invalid"; message: string }
  /** Lectura válida de la Systel que no se cobra sola (TOTAL, venta libre, producto sin vínculo, etc.). */
  | { kind: "blocking"; message: string }
  | { kind: "item"; product: Product; quantity: number; unitPrice: number; scaleKey: string; description: string };

export type LabelResolution =
  /** Una sola lectura: la del formato de la sucursal (resolveScan), incluidos sus avisos de error o "buscar". */
  | { type: "scan"; resolution: ScanResolution }
  /** Una sola lectura: la de la balanza Systel. */
  | { type: "systel"; product: Product; quantity: number; unitPrice: number; scaleKey: string; description: string }
  /** La Systel dice qué pasa con el código (no se agrega nada). */
  | { type: "systel_message"; message: string }
  | { type: "ambiguous"; options: LabelChoiceOption[]; note?: string }
  /** El formato de la balanza todavía no se conoce (C5): no se lee la etiqueta. */
  | { type: "not_ready"; message: string };

const SAME_KG = 0.0005;

/** Lo que dice la balanza Systel de la sucursal sobre el código (misma lógica que useScalePapers.handleScan). */
export function systelReading(raw: string, setups: ScaleSetup[], products: Product[]): SystelReading {
  if (setups.length === 0) return { kind: "not_scale" };
  const m = decodeAcross(raw, setups, null);
  if (m.kind === "not_scale") return { kind: "not_scale" };
  if (m.kind === "ambiguous") return { kind: "blocking", message: "No se agregó: dos balanzas de esta sucursal imprimen ese mismo código y no se puede saber de cuál es. Avisale a soporte de Patagonia." };
  const { setup, decoded: d } = m;
  if (d.kind === "not_scale") return { kind: "not_scale" };
  if (d.kind === "error") return { kind: "invalid", message: `No se agregó: ${d.reason}.` };
  if (d.kind === "total") return { kind: "blocking", message: "Ese es el TOTAL del ticket de la balanza. Escaneá el código de cada producto (el que está debajo de cada uno): el TOTAL no hace falta." };
  const linked = setup.links.some((l) => l.code === d.code && l.kind !== "none");
  const r = addScannedItem(emptyPaper(), d, setup.links, products);
  if (!d.item && !d.generic && !linked) return { kind: "invalid", message: r.ok ? `No se agregó: el producto N.º ${d.code} no está en esa balanza.` : r.reason };
  if (!r.ok) return { kind: "blocking", message: r.reason };
  const it = r.item;
  if (it.kind !== "product" || !it.productId) {
    return { kind: "blocking", message: `No se agregó: ${describeItem(it)} es venta libre de la balanza (sin producto de Patagonia). Cargala a mano con su importe.` };
  }
  const product = products.find((p) => p.id === it.productId);
  if (!product) return { kind: "blocking", message: `No se agregó: ${describeItem(it)} está vinculado a un producto que no está en Patagonia.` };
  // Una Cuora pesa hasta 31 kg: más que eso es otra etiqueta leída con el formato de la Systel (real: la Kretz de M2
  // "2000258567506" daba PATA DESH.x10 de 856,75 kg).
  if (it.unit === "kg" && it.quantity > MAX_COUNTER_SCALE_KG) {
    return { kind: "invalid", message: `No se agregó: con el formato de la balanza Systel la etiqueta da ${it.quantity.toLocaleString("es-AR")} kg de ${product.name}, que no puede pesar una balanza de mostrador. Buscalo por nombre y cargá lo que dice el papel.` };
  }
  const unitPrice = product.priceRetail > 0 ? product.priceRetail : it.prices[0] ?? 0;
  return { kind: "item", product, quantity: it.quantity, unitPrice, scaleKey: setup.profile.scaleKey, description: describeItem(it) };
}

function original<T extends { product: Product }>(x: T, byId: Map<string, Product>): T {
  return { ...x, product: byId.get(x.product.id) ?? x.product };
}

function withOriginalProducts(r: ScanResolution, byId: Map<string, Product>): ScanResolution {
  if (r.type === "label" || r.type === "product") return original(r, byId);
  if (r.type === "ambiguous") return { ...r, options: r.options.map((o) => (o.type === "label" ? original(o, byId) : o)) };
  return r;
}

/** Lecturas cobrables de resolveScan (las que pueden competir con otra). */
function scanCandidates(r: ScanResolution): ScanChoice[] {
  const ok = (c: ScanChoice) => c.type === "ticket_total" || labelWeightProblem(c.product.unit, c.quantity) === null;
  if (r.type === "label" || r.type === "ticket_total") return ok(r) ? [r] : [];
  if (r.type === "ambiguous") return r.options.filter(ok);
  return [];
}

const qtyText = (q: number, unit: string) => (unit === "kg" ? `${q.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg` : `${q} u.`);

function systelOption(s: Extract<SystelReading, { kind: "item" }>): LabelChoiceOption {
  const amount = Math.round(s.quantity * s.unitPrice * 100) / 100;
  return {
    title: `${s.product.name} ${qtyText(s.quantity, s.product.unit)} ${formatMoney(amount)}`,
    detail: `Etiqueta de la balanza Systel (${s.description})`,
    pick: { type: "systel", product: s.product, quantity: s.quantity, unitPrice: s.unitPrice, scaleKey: s.scaleKey }
  };
}

/** Formato de fábrica de las Systel (20 + producto 4 + gramos 6): solo para la duda E15 de una sucursal sin formato. */
const SYSTEL_FACTORY_CONFIG: ScaleConfig = { prefixLength: 2, pluLength: 4, weightLength: 6, weightDivisor: 1000, totalLength: 13, payloadType: "weight" };

export function resolveScaleLabel(rawInput: string, ctx: LabelContext): LabelResolution {
  const raw = rawInput.trim();
  // Con zona, la lectura usa el precio de la balanza del local; el producto que se devuelve es siempre el original.
  const zone = ctx.zoneListId ?? null;
  const byId = new Map(ctx.products.map((p) => [p.id, p]));
  const scanProducts = zone ? ctx.products.map((p) => ({ ...p, priceRetail: scalePrintedPrice(p, zone) })) : ctx.products;
  const lp = ctx.labelProfiles;
  const read = (r: string, ps: Product[]) => (lp ? resolveScanByProfiles(r, ps, lp.profiles, ctx.config) : resolveScan(r, ps, ctx.config));
  const scan = zone ? withOriginalProducts(read(raw, scanProducts), byId) : read(raw, ctx.products);
  const priceOf = (p: Product) => scalePrintedPrice(p, zone);
  const asScan = (): LabelResolution => (scan.type === "ambiguous" ? { type: "ambiguous", options: scanChoiceOptions(scan.options, priceOf), ...(scan.note ? { note: scan.note } : {}) } : { type: "scan", resolution: scan });
  /**
   * E15 (TripleS 13/10, real): con la sucursal SIN formato guardado y sin balanzas configuradas, la etiqueta se lee con
   * el formato de fábrica de Kretz (1-5-5). Una Systel imprime 20 + producto 4 + gramos 6: la misma etiqueta de 0,175 kg
   * entraba como 0,017 kg sin aviso. No se sabe qué balanza hay, así que se lee también con el de fábrica de Systel: si
   * las dos lecturas encuentran producto y dicen algo distinto, es ambigua (la cajera mira el papel y elige). Si coinciden
   * o solo una tiene sentido, se cobra como siempre (no frena a los locales Kretz que venden con el de fábrica).
   */
  const factoryDoubt = (): LabelResolution | null => {
    if (ctx.calibrated || ctx.setups.length > 0 || (lp && lp.profiles.length > 0) || scan.type !== "label") return null;
    const alt = resolveScan(raw, zone ? scanProducts : ctx.products, SYSTEL_FACTORY_CONFIG);
    const altScan = zone ? withOriginalProducts(alt, byId) : alt;
    if (altScan.type !== "label" || labelWeightProblem(altScan.product.unit, altScan.quantity) !== null) return null;
    const same = altScan.product.id === scan.product.id && Math.abs(altScan.quantity - scan.quantity) < SAME_KG;
    if (same) return null;
    return { type: "ambiguous", options: scanChoiceOptions([scan, altScan], priceOf), note: "Esta sucursal no tiene configurado el formato de la balanza: calibralo en el engranaje de Mostrador para que no pregunte más." };
  };
  // Un código idéntico al de un producto gana sobre cualquier lectura de balanza (como siempre).
  if (ctx.products.some((p) => p.code === raw)) return { type: "scan", resolution: scan };
  // C5: sin formato conocido no se lee ninguna etiqueta de balanza (códigos del rango de comercio "2…" o TOTAL "0000…").
  const baseStatus = ctx.configStatus ?? (isScaleConfigUnknown(ctx.config) ? "unknown" : "ready");
  const status = lp && lp.status !== "ready" ? lp.status : baseStatus;
  if (status !== "ready" && /^(2\d{11,12}|0000\d{8,9})$/.test(raw)) {
    return { type: "not_ready", message: status === "loading" ? SCALE_CONFIG_LOADING_MESSAGE : SCALE_CONFIG_UNKNOWN_MESSAGE };
  }

  const s = systelReading(raw, ctx.setups, ctx.products);
  if (s.kind === "not_scale") return factoryDoubt() ?? asScan();

  // Lecturas del formato de la sucursal: sirven de respaldo cuando la Systel no reconoce la etiqueta, y compiten con una
  // lectura Systel válida solo si el local tiene (o puede tener) otra marca de balanza.
  const fallback = ctx.calibrated ? scanCandidates(scan) : [];
  const others = ctx.branchFormatCompetes !== false ? fallback : [];
  if (s.kind === "invalid") return fallback.length > 0 ? asScan() : { type: "systel_message", message: s.message };
  if (s.kind === "blocking") {
    if (others.length === 0) return { type: "systel_message", message: s.message };
    return { type: "ambiguous", options: scanChoiceOptions(others, priceOf), note: `También puede ser de la balanza Systel: ${s.message.replace(/^No se agregó: /, "")}` };
  }
  // Lectura Systel válida: ¿alguna otra lectura válida dice algo distinto?
  const different = others.filter((c) => !(c.type === "label" && c.product.id === s.product.id && Math.abs(c.quantity - s.quantity) < SAME_KG));
  if (different.length === 0) return { type: "systel", product: s.product, quantity: s.quantity, unitPrice: s.unitPrice, scaleKey: s.scaleKey, description: s.description };
  return { type: "ambiguous", options: [systelOption(s), ...scanChoiceOptions(different, priceOf)], ...(scan.type === "ambiguous" && scan.note ? { note: scan.note } : {}) };
}
