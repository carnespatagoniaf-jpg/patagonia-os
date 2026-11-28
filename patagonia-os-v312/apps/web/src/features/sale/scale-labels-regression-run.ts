import type { Product } from "@patagonia/domain";
import type { ScaleConfig } from "./scale-barcode";
import { labelWeightProblem, resolveScan, type ScanResolution } from "./scan-resolve";
import { resolveScanByProfiles } from "./scale-profile-scan";
import type { ScaleLabelProfile } from "../scales/label-spec";
import { systelConfigForCodeAcross, type SystelLabelTemplates } from "./systel-label-format";
import { decodeAcross } from "../scales/sale/multi-decode";
import { addScannedItem, emptyPaper } from "../scales/sale/paper";
import type { ScaleLink, ScaleSaleProfile } from "../scales/sale/profile";
import type { ScaleSetup } from "../scales/sale/scale-sale-service";

/**
 * Lectura de una etiqueta como la hace Mostrador hoy, en un texto corto y fácil de comparar. Lo usa el banco de
 * regresión (scale-labels-regression.test.ts + fixtures/etiquetas-reales.json). Lógica pura, sin pantallas: llama
 * exactamente a las mismas funciones que useSaleTicket / useScalePapers, en el mismo orden para cada camino.
 */

export type RegressionProduct = [code: string, name: string, unit: "kg" | "unit", price: number, active?: boolean];

interface BaseContext {
  cliente: string;
  descripcion: string;
  productos: RegressionProduct[];
}

export type RegressionContext =
  | (BaseContext & { lector: "sucursal"; formato: ScaleConfig })
  | (BaseContext & { lector: "perfil"; balanzas: { perfil: ScaleSaleProfile; vinculos: [number, string][] }[] })
  | (BaseContext & { lector: "systel_piloto"; plantillas: SystelLabelTemplates[]; formato: ScaleConfig });

export interface RegressionLabel {
  codigo: string;
  cliente: string;
  contexto: string;
  evidencia: "real" | "prueba";
  fuente: string;
  /** Lo que dice el papel (si se sabe), para quien lee el banco. */
  papel?: string;
  esperado: string;
  mensaje?: string;
  sospechoso?: string;
}

export interface RegressionBank {
  contextos: Record<string, RegressionContext>;
  etiquetas: RegressionLabel[];
}

export interface RegressionReading {
  resultado: string;
  /** Texto del aviso, cuando lo hay (rechazos y totales que no se cargan). */
  mensaje: string;
}

export const productId = (code: string) => `id-${code}`;

export function regressionProducts(rows: RegressionProduct[]): Product[] {
  return rows.map(([code, name, unit, priceRetail, active]) => ({ id: productId(code), code, name, unit, priceRetail, cost: 0, stock: 0, minStock: 0, active: active ?? true }) as unknown as Product);
}

/** Números como los escribe la persona que mira la tabla: sin ceros de más, con punto decimal. */
const num = (n: number) => String(Math.round(n * 1000) / 1000);

function describeResolution(r: ScanResolution): RegressionReading {
  switch (r.type) {
    case "label": {
      const qty = r.product.unit === "kg" ? `kg=${num(r.quantity)}` : `u=${num(r.quantity)}`;
      const amount = r.amount !== undefined ? ` importe=${num(r.amount)}` : "";
      // Mostrador pregunta antes de agregar más de 31 kg (useSaleTicket, labelWeightProblem).
      const ask = labelWeightProblem(r.product.unit, r.quantity) === "excesivo" ? " pregunta=excesivo" : "";
      return { resultado: `ETIQUETA prod=${r.product.code} ${qty}${amount}${ask}`, mensaje: r.detail };
    }
    case "product":
      return { resultado: `PRODUCTO prod=${r.product.code}`, mensaje: "" };
    case "ticket_total":
      return { resultado: `TOTAL importe=${num(r.amount)}`, mensaje: "" };
    case "systel_total":
      return { resultado: `TOTAL_SYSTEL importe=${num(r.amount)}`, mensaje: r.message };
    case "ticket_without_amount":
      return { resultado: "SIN_IMPORTE", mensaje: r.message };
    case "error":
      return { resultado: "RECHAZO", mensaje: r.message };
    case "search":
      return { resultado: "BUSQUEDA", mensaje: "" };
    default: {
      // "ambiguous" (regla de oro, PR #111): dos lecturas válidas distintas, no se cobra nada y la cajera elige.
      const other = r as { type: string; options?: unknown[] };
      return other.type === "ambiguous"
        ? { resultado: "AMBIGUO", mensaje: `${other.options?.length ?? 0} opciones` }
        : { resultado: `OTRO ${other.type}`, mensaje: "" };
    }
  }
}

function readWithProfiles(raw: string, ctx: Extract<RegressionContext, { lector: "perfil" }>, products: Product[]): RegressionReading {
  const setups: ScaleSetup[] = ctx.balanzas.map((b) => ({
    profile: b.perfil,
    links: b.vinculos.map(([code, productCode]): ScaleLink => ({ code, kind: "product", productId: productId(productCode) })),
    readAt: null,
    repeatWindowMinutes: 3,
    active: true
  }));
  // Igual que useScalePapers.handleScan, con el papel vacío (primer código de la venta).
  const m = decodeAcross(raw, setups, null, undefined, null);
  if (m.kind === "not_scale") return { resultado: "NO_ES_BALANZA", mensaje: "" };
  if (m.kind === "ambiguous") return { resultado: "AMBIGUO", mensaje: m.names.join(", ") };
  const d = m.decoded;
  if (d.kind === "not_scale") return { resultado: "NO_ES_BALANZA", mensaje: "" };
  if (d.kind === "error") return { resultado: "RECHAZO", mensaje: d.reason };
  if (d.kind === "total") return { resultado: `PAPEL_TOTAL importe=${num(d.amount)}${d.articles !== null ? ` articulos=${d.articles}` : ""}`, mensaje: "" };
  const added = addScannedItem(emptyPaper(), d, m.setup.links, products);
  if (!added.ok) return { resultado: "RECHAZO", mensaje: added.reason };
  const it = added.item;
  if (it.kind !== "product" || !it.productId) return { resultado: "RECHAZO", mensaje: "venta libre de la balanza (sin producto de Patagonia)" };
  const product = products.find((p) => p.id === it.productId);
  const qty = it.unit === "kg" ? `kg=${num(it.quantity)}` : `u=${num(it.quantity)}`;
  const amount = it.amount !== null && it.amount !== undefined ? ` importe_codigo=${num(it.amount)}` : "";
  return { resultado: `PAPEL prod=${product?.code ?? "?"} ${qty}${amount}`, mensaje: "" };
}

export function readLabel(raw: string, ctx: RegressionContext): RegressionReading {
  const products = regressionProducts(ctx.productos);
  if (ctx.lector === "sucursal") return describeResolution(resolveScan(raw, products, ctx.formato));
  if (ctx.lector === "perfil") return readWithProfiles(raw, ctx, products);
  // Piloto Systel (useSaleTicket): el formato que informó la balanza manda sobre el de la sucursal.
  const systel = systelConfigForCodeAcross(raw, ctx.plantillas);
  if (systel === "no_soportado") return { resultado: "NO_SOPORTADO", mensaje: "La balanza imprime el código de los productos con un formato que Patagonia no puede leer sin riesgo" };
  return describeResolution(resolveScan(raw, products, systel ?? ctx.formato));
}

/** 'balanzas_v2': la misma etiqueta leída preguntándole a cada balanza de la sucursal (scale-profile-scan.ts). */
export function readLabelByProfiles(raw: string, ctx: RegressionContext, profiles: ScaleLabelProfile[]): RegressionReading {
  if (ctx.lector !== "sucursal") return readLabel(raw, ctx);
  return describeResolution(resolveScanByProfiles(raw, regressionProducts(ctx.productos), profiles, ctx.formato));
}
