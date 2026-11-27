import { formatMoney } from "../shifts/format";
import type { ScanChoice } from "./scan-resolve";

/**
 * Opciones que se muestran cuando una etiqueta de balanza es AMBIGUA (regla de oro, 26/11): nombre del producto, kilos
 * e importe, o "TOTAL del ticket". Puro (sin pantallas), para Mostrador y Clientes.
 */

export interface LabelChoiceOption {
  title: string;
  detail?: string;
  pick: ScanChoice;
}

const qtyText = (q: number, unit: string) => (unit === "kg" ? `${q.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg` : `${q} u.`);

/** Texto de una lectura posible. `priceOf`: precio con el que imprimió la balanza (para el importe de una etiqueta de peso). */
export function describeScanChoice(c: ScanChoice, priceOf: (p: ScanChoiceProduct) => number = (p) => p.priceRetail): Omit<LabelChoiceOption, "pick"> {
  if (c.type === "ticket_total") {
    return { title: `TOTAL del ticket: ${formatMoney(c.amount)}`, detail: "Ticket con varios productos: después hay que detallar cada producto del papel." };
  }
  const amount = c.amount ?? Math.round(c.quantity * priceOf(c.product) * 100) / 100;
  return { title: `${c.product.name} ${qtyText(c.quantity, c.product.unit)} ${formatMoney(amount)}`, detail: `Producto N.º ${c.product.code} de Patagonia` };
}

type ScanChoiceProduct = Extract<ScanChoice, { type: "label" }>["product"];

export function scanChoiceOptions(options: ScanChoice[], priceOf?: (p: ScanChoiceProduct) => number): LabelChoiceOption[] {
  return options.map((pick) => ({ ...describeScanChoice(pick, priceOf), pick }));
}
