import type { Product } from "@patagonia/domain";
import { buildCode, parseTemplate } from "./label-template";
import { addLibreFromPaper, addScannedItem, closePaper, emptyPaper, paperFingerprint, type Paper } from "./paper";
import { decodeScaleCode, expectedItemCode, type ScaleLink, type ScaleSaleProfile } from "./profile";
import type { RealTicket } from "./los-gringos-fixture";

/**
 * Simula al cajero con un ticket REAL:
 * - escanea el código que imprimiría la balanza debajo de cada artículo;
 * - agrega las ventas libres con el importe del papel;
 * - escanea el TOTAL;
 * - si hace falta, copia los importes del papel.
 *
 * Supuestos (a confirmar con un ticket real impreso):
 * - los artículos de $0 sin cantidad son artículos anulados en la balanza: no se imprimen ni se cuentan;
 * - los genéricos (8001/8002) no imprimen código porque su código no entra en PPPP (manual, pág. 42), así que el
 *   cajero los agrega como venta libre con su importe.
 */
export interface ReplayResult {
  ok: boolean;
  method?: "listas" | "papel";
  /** Por cada artículo cobrado: producto (o null si es venta libre), cantidad e importe. */
  lines: Array<{ productId: string | null; quantity: number; amount: number; realAmount: number }>;
  fingerprint?: string;
  problem?: string;
  totalBarcode?: string;
}

export function replayTicket(t: RealTicket, profile: ScaleSaleProfile, links: ScaleLink[], products: Product[]): ReplayResult {
  const printed = t.lines.filter((l) => l.amount > 0 || l.units > 0 || l.grams > 0);
  let paper: Paper = emptyPaper();
  const real: number[] = [];
  for (const l of printed) {
    if (profile.genericCodes.includes(l.plu)) {
      paper = addLibreFromPaper(paper, l.amount);
      real.push(l.amount);
      continue;
    }
    const item = profile.catalog.find((i) => i.code === l.plu);
    if (!item) return { ok: false, lines: [], problem: `PLU ${l.plu} no está en el catálogo` };
    const code = expectedItemCode(item, profile, l.grams > 0 ? l.grams / 1000 : l.units);
    if (!code) return { ok: false, lines: [], problem: `la balanza no imprimiría el código del PLU ${l.plu}` };
    const r = addScannedItem(paper, decodeScaleCode(code, profile), links, products);
    if (!r.ok) return { ok: false, lines: [], problem: r.reason };
    paper = r.paper;
    real.push(l.amount);
  }
  const total = printed.reduce((s, l) => s + l.amount, 0);
  const tt = parseTemplate(profile.totalFormat)!;
  const totalBarcode = buildCode(tt, { A: printed.length, I: total * 10 ** profile.amountDecimals, B: 0 });
  if (!totalBarcode) return { ok: false, lines: [], problem: "el TOTAL no entra en el código" };
  const scan = decodeScaleCode(totalBarcode, profile);
  if (scan.kind !== "total") return { ok: false, lines: [], problem: "el TOTAL no se reconoce" };
  let close = closePaper(paper, scan);
  if (!close.ok && close.need === "paper_amounts") {
    close = closePaper(paper, scan, paper.items.map((it, i) => (it.kind === "product" ? real[i] : -1)).filter((a) => a >= 0));
  }
  if (!close.ok) return { ok: false, lines: [], problem: close.reason, totalBarcode };
  return {
    ok: true,
    method: close.method,
    totalBarcode,
    fingerprint: paperFingerprint(totalBarcode, paper),
    lines: paper.items.map((it, i) => ({ productId: it.productId, quantity: it.quantity, amount: close.ok ? close.amounts[i] : 0, realAmount: real[i] }))
  };
}
