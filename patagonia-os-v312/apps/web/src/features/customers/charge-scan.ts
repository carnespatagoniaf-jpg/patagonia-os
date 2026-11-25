import type { Product } from "@patagonia/domain";
import { resolveBoxScan, type BoxLabelFormat } from "../sale/box-label";
import type { ScaleConfig } from "../sale/scale-barcode";
import { labelWeightProblem, resolveScan } from "../sale/scan-resolve";

/**
 * Qué hacer con un código escaneado (o tipeado + Enter) en Clientes → "+ Venta a cuenta". Usa la misma lectura que
 * Mostrador (scan-resolve.ts, box-label.ts): código exacto del producto, etiqueta de la balanza (producto + kilos) o
 * caja con etiqueta del frigorífico. Lógica pura, sin pantallas (charge-scan.test.ts).
 *
 * El precio NO sale de la etiqueta: la venta a cuenta se cobra al precio del cliente (su lista o el minorista), igual
 * que create_customer_charge_with_items en la base. De la etiqueta solo se toma el producto y la cantidad.
 *
 * Los tickets de TOTAL de la balanza no se cargan: no dicen qué productos son, y la venta a cuenta necesita el detalle.
 */
export type ChargeScan =
  | { type: "add"; product: Product; quantity: number; detail: string; /** Peso de etiqueta fuera de lo normal: preguntar antes. */ confirm?: string }
  | { type: "error"; message: string }
  | { type: "search" };

const TOTAL_TICKET_MESSAGE =
  "Ese es el código del TOTAL del ticket de la balanza: no dice qué productos son. No se agregó nada: escaneá el código de cada producto (el que está debajo de cada uno) o buscalo por nombre.";

export function resolveChargeScan(rawInput: string, products: Product[], config: ScaleConfig, boxFormats: BoxLabelFormat[] = []): ChargeScan {
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

  const resolved = resolveScan(raw, products, config);
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
    default:
      return { type: "search" };
  }
}
