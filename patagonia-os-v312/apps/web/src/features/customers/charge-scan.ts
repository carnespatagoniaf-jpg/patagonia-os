import type { Product } from "@patagonia/domain";
import { resolveBoxScan, type BoxLabelFormat } from "../sale/box-label";
import type { ScaleConfig } from "../sale/scale-barcode";
import { labelWeightProblem, resolveScan, type ScanResolution } from "../sale/scan-resolve";
import { resolveScaleLabel } from "../sale/scale-label-resolver";
import { scanChoiceOptions, type LabelChoiceOption } from "../sale/scale-label-choice";
import type { ScaleSetup } from "../scales/sale/scale-sale-service";
import type { ScaleConfigStatus } from "../sale/scale-config-cache";

/**
 * Qué hacer con un código escaneado (o tipeado + Enter) en Clientes → "+ Venta a cuenta". Usa el MISMO resolvedor que
 * Mostrador (scale-label-resolver.ts: balanzas Systel de la sucursal + formato de la sucursal, misma regla de
 * ambigüedad; box-label.ts para cajas): código exacto del producto, etiqueta de la balanza (producto + kilos) o
 * caja con etiqueta del frigorífico. Lógica pura, sin pantallas (charge-scan.test.ts).
 * Los kilos de una etiqueta con importe salen del precio con el que imprimió la balanza (zona del local o general),
 * igual que en Mostrador, nunca del precio de la lista del cliente.
 *
 * El precio NO sale de la etiqueta: la venta a cuenta se cobra al precio del cliente (su lista o el minorista), igual
 * que create_customer_charge_with_items en la base. De la etiqueta solo se toma el producto y la cantidad.
 *
 * Los tickets de TOTAL de la balanza no se cargan: no dicen qué productos son, y la venta a cuenta necesita el detalle.
 */
export type ChargeScan =
  | { type: "add"; product: Product; quantity: number; detail: string; /** Peso de etiqueta fuera de lo normal: preguntar antes. */ confirm?: string }
  /** Etiqueta ambigua (regla de oro, igual que Mostrador): no se agrega nada; la persona elige o carga a mano. */
  | { type: "choose"; options: LabelChoiceOption[]; note?: string }
  | { type: "error"; message: string }
  | { type: "search" };

/** Lo que la venta a cuenta sabe de las balanzas de la sucursal: lo mismo que usa Mostrador (scale-label-resolver.ts). */
export interface ChargeScaleContext {
  /** La sucursal tiene su formato de etiquetas guardado (no el de fábrica). */
  calibrated: boolean;
  /** Balanzas "artículos + TOTAL" (Systel) de la sucursal. */
  setups: ScaleSetup[];
  /** Zona de precios del local: los kilos de una etiqueta con importe salen del precio de la balanza (C4). */
  zoneListId?: string | null;
  /** C5: mientras no se conoce el formato de la balanza, no se lee ninguna etiqueta. */
  configStatus?: ScaleConfigStatus;
}

const TOTAL_TICKET_MESSAGE =
  "Ese es el código del TOTAL del ticket de la balanza: no dice qué productos son. No se agregó nada: escaneá el código de cada producto (el que está debajo de cada uno) o buscalo por nombre.";

export function resolveChargeScan(rawInput: string, products: Product[], config: ScaleConfig, boxFormats: BoxLabelFormat[] = [], scale: ChargeScaleContext = { calibrated: true, setups: [] }): ChargeScan {
  const raw = rawInput.trim();
  if (!raw) return { type: "search" };
  const active = products.filter((p) => p.active ?? true);

  // Caja del frigorífico: solo si el código no es un producto y no es una etiqueta de balanza de un producto que existe
  // (mismo orden que Mostrador).
  if (boxFormats.length > 0 && !active.some((p) => p.code === raw)) {
    const box = resolveBoxScan(raw, boxFormats, products);
    if (box && resolveScan(raw, products, config).type !== "label") {
      return { type: "add", product: box.product, quantity: box.quantity, detail: box.detail };
    }
  }

  const label = resolveScaleLabel(raw, { products, config, calibrated: scale.calibrated, setups: scale.setups, zoneListId: scale.zoneListId ?? null, configStatus: scale.configStatus });
  if (label.type === "not_ready") return { type: "error", message: label.message };
  if (label.type === "ambiguous") return { type: "choose", options: label.options, ...(label.note ? { note: label.note } : {}) };
  if (label.type === "systel_message") return { type: "error", message: label.message };
  if (label.type === "systel") {
    const qty = label.product.unit === "kg" ? `${label.quantity.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg` : `${label.quantity} u.`;
    return { type: "add", product: label.product, quantity: label.quantity, detail: `${label.product.name}: ${qty} (etiqueta de balanza)` };
  }
  return fromScan(label.resolution);
}

/** Lo que se agrega al elegir una opción de una etiqueta ambigua. */
export function chargeScanFromChoice(option: LabelChoiceOption): ChargeScan {
  const pick = option.pick;
  if (pick.type === "systel") return { type: "add", product: pick.product, quantity: pick.quantity, detail: option.title };
  return fromScan(pick);
}

function fromScan(resolved: ScanResolution): ChargeScan {
  switch (resolved.type) {
    case "product":
      return { type: "add", product: resolved.product, quantity: 1, detail: resolved.product.name };
    case "label": {
      const problem = labelWeightProblem(resolved.product.unit, resolved.quantity);
      if (problem === "invalido") return { type: "error", message: `La etiqueta de ${resolved.product.name} trae una cantidad que no sirve. No se agregó nada.` };
      return {
        type: "add",
        product: resolved.product,
        quantity: resolved.quantity,
        detail: resolved.detail,
        ...(problem === "excesivo"
          ? { confirm: `La etiqueta dice ${resolved.quantity.toLocaleString("es-AR", { maximumFractionDigits: 3 })} kg de ${resolved.product.name}, más de lo que pesa una balanza de mostrador. ¿Agregarlo igual?` }
          : {})
      };
    }
    case "ticket_total":
    case "systel_total":
      return { type: "error", message: TOTAL_TICKET_MESSAGE };
    case "ticket_without_amount":
    case "error":
      return { type: "error", message: resolved.message };
    case "ambiguous":
      return { type: "choose", options: scanChoiceOptions(resolved.options), ...(resolved.note ? { note: resolved.note } : {}) };
    default:
      return { type: "search" };
  }
}
