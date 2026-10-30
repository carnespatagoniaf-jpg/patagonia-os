import type { Product } from "@patagonia/domain";
import { resolveScan, labelWeightProblem } from "../sale/scan-resolve";
import type { ScaleConfig } from "../sale/scale-barcode";
import { systelConfigForCodeAcross, type SystelLabelTemplates } from "../sale/systel-label-format";
import { decodeAcross } from "./sale/multi-decode";
import { addScannedItem, describeItem } from "./sale/paper";
import type { ScaleSetup } from "./sale/scale-sale-service";

/**
 * "Probá una etiqueta" en Mi balanza (pedido del dueño 30/10: los clientes pasaban los productos y no sabían dónde
 * escanear la etiqueta para el último paso). Lee el código EXACTAMENTE como Mostrador (mismo orden: balanzas
 * "artículos + TOTAL" de la sucursal, formato Systel, formato de la sucursal) y lo dice en criollo. No cobra nada ni
 * toca stock. Lógica pura, testeada (label-test.test.ts).
 */

export type LabelTestResult =
  | { ok: true; title: string; detail: string }
  | { ok: false; title: string; detail: string };

const money = (n: number) => `$${n.toLocaleString("es-AR", { maximumFractionDigits: 2 })}`;
const qty = (q: number, unit: string) => (unit === "kg" ? `${q.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg` : `${q} u.`);

export interface LabelTestDeps {
  products: Product[];
  config: ScaleConfig;
  /** Balanzas "artículos + TOTAL" de la sucursal (Mostrador las mira primero). */
  setups?: ScaleSetup[];
  /** Formatos Systel (solo empresas piloto, como Mostrador). */
  systelTemplates?: SystelLabelTemplates[];
}

export function labelTestResult(rawInput: string, deps: LabelTestDeps): LabelTestResult | null {
  const raw = rawInput.trim();
  if (!raw) return null;
  const { products, config, setups = [], systelTemplates = [] } = deps;

  const exact = products.find((p) => (p.active ?? true) && p.code === raw);
  if (exact) {
    return {
      ok: false,
      title: "Ese es el código de un producto, no una etiqueta de balanza",
      detail: `El código ${raw} es "${exact.name}" en Patagonia. Pesá algo en la balanza, que imprima la etiqueta, y escaneá el código de barras de ESA etiqueta.`
    };
  }

  if (setups.length > 0) {
    const m = decodeAcross(raw, setups, null);
    if (m.kind === "ambiguous") {
      return { ok: false, title: "Dos balanzas imprimen ese mismo código", detail: "No se puede saber de cuál es. Avisale a soporte de Patagonia." };
    }
    if (m.kind === "match") {
      const d = m.decoded;
      if (d.kind === "error") return { ok: false, title: "La etiqueta no se pudo leer", detail: `${d.reason}.` };
      if (d.kind === "total") {
        return { ok: true, title: "Ticket TOTAL leído bien", detail: `Total ${money(d.amount)}${d.articles ? ` · ${d.articles} artículos` : ""}. En Mostrador se escanea primero el código de cada producto y al final este TOTAL.` };
      }
      if (d.kind === "item") {
        const r = addScannedItem({ items: [] }, d, m.setup.links, products);
        if (!r.ok) return { ok: false, title: "La etiqueta se leyó, pero no se podría cobrar", detail: r.reason };
        return { ok: true, title: "Etiqueta leída bien", detail: `${describeItem(r.item)}${r.item.amount ? ` · ${money(r.item.amount)}` : ""}. Fijate que sea lo mismo que dice la etiqueta.` };
      }
    }
  }

  const systelConfig = systelTemplates.length > 0 ? systelConfigForCodeAcross(raw, systelTemplates) : null;
  if (systelConfig === "no_soportado") {
    return { ok: false, title: "Formato de etiqueta que Patagonia no puede leer", detail: "La balanza imprime el código con un formato que Patagonia no lee sin riesgo de cargar mal los kilos. Avisale a soporte con una foto de la etiqueta." };
  }

  const r = resolveScan(raw, products, systelConfig ?? config);
  switch (r.type) {
    case "label": {
      if (labelWeightProblem(r.product.unit, r.quantity) === "excesivo") {
        return {
          ok: false,
          title: "La etiqueta se lee con demasiados kilos",
          detail: `Patagonia leyó ${r.product.name}: ${qty(r.quantity, r.product.unit)}, más de lo que pesa una balanza de mostrador. Casi seguro el formato del código de barras no es el de esta sucursal. Avisale a soporte con una foto de la etiqueta.`
        };
      }
      const total = r.amount ?? Math.round(r.quantity * r.product.priceRetail * 100) / 100;
      return { ok: true, title: "Etiqueta leída bien", detail: `${r.product.name}: ${qty(r.quantity, r.product.unit)} · ${money(total)}. Fijate que sea lo mismo que dice la etiqueta.` };
    }
    case "ticket_total":
      return { ok: true, title: "Ticket TOTAL leído bien", detail: `Total ${money(r.amount)}. En Mostrador se cobra ese importe.` };
    case "systel_total":
      return { ok: false, title: "Ese es el código del TOTAL del ticket", detail: "Para la prueba, escaneá el código que está debajo de UN producto del ticket." };
    case "ticket_without_amount":
    case "error":
      return { ok: false, title: "La etiqueta no se pudo leer", detail: r.message };
    case "product":
      return { ok: false, title: "Ese es el código de un producto, no una etiqueta de balanza", detail: `El código ${raw} es "${r.product.name}" en Patagonia.` };
    default:
      if (/^2[0-9]{11,12}$/.test(raw)) {
        return {
          ok: false,
          title: "Parece una etiqueta, pero no tiene el formato de esta sucursal",
          detail: `Patagonia espera códigos de ${config.totalLength > 0 ? config.totalLength : 13} números y este tiene ${raw.length}. Volvé a pasar los productos a la balanza (así Patagonia le acomoda el código de barras) y probá con una etiqueta nueva. Si sigue igual, avisale a soporte.`
        };
      }
      return { ok: false, title: "Eso no es una etiqueta de balanza", detail: `Se leyó "${raw}". Escaneá el código de barras de la etiqueta que imprimió la balanza.` };
  }
}
