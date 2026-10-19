import { decodeScaleCode, type DecodedScan } from "./profile";
import type { ScaleSetup } from "./scale-sale-service";

/**
 * Mostrador con VARIAS balanzas de venta en la sucursal (migración 134): de qué balanza es este código.
 *
 * - Si solo una lo reconoce, es esa.
 * - Si el papel abierto ya es de una balanza y esa lo reconoce, es esa (los artículos y el TOTAL del mismo papel).
 * - Si dos lo reconocen de forma distinta, NO se adivina: se avisa (pasa si dos balanzas imprimen el mismo formato
 *   de código; se arregla una vez, cambiando el prefijo en una de ellas).
 */

export type MultiDecoded =
  | { kind: "match"; setup: ScaleSetup; decoded: DecodedScan }
  | { kind: "not_scale" }
  | { kind: "ambiguous"; names: string[] };

function sameMeaning(a: DecodedScan, b: DecodedScan): boolean {
  if (a.kind === "total" && b.kind === "total") return a.amount === b.amount && a.articles === b.articles;
  if (a.kind === "item" && b.kind === "item") return a.code === b.code && a.quantity === b.quantity && a.generic === b.generic && (a.item?.saleType ?? null) === (b.item?.saleType ?? null);
  return false;
}

export function decodeAcross(raw: string, setups: ScaleSetup[], preferKey: string | null, nameOf: (key: string) => string = (k) => k): MultiDecoded {
  const hits = setups.map((setup) => ({ setup, decoded: decodeScaleCode(raw, setup.profile) })).filter((h) => h.decoded.kind !== "not_scale");
  if (hits.length === 0) return { kind: "not_scale" };
  if (preferKey) {
    const pref = hits.find((h) => h.setup.profile.scaleKey === preferKey);
    if (pref) return { kind: "match", ...pref };
  }
  if (hits.length === 1) return { kind: "match", ...hits[0] };
  const good = hits.filter((h) => h.decoded.kind !== "error");
  if (good.length === 1) return { kind: "match", ...good[0] };
  if (good.length === 0) return { kind: "match", ...hits[0] };
  // Dos balanzas con el mismo formato que dicen EXACTAMENTE lo mismo (mismo producto y cantidad, o el mismo TOTAL):
  // para cobrar da igual cuál fue. Se usa siempre la primera, así un papel repetido se detecta igual. Real: Los gringos
  // agregó una segunda Systel (19/10) que imprime como la primera.
  if (good.every((h) => sameMeaning(h.decoded, good[0].decoded))) return { kind: "match", ...good[0] };
  return { kind: "ambiguous", names: good.map((h) => nameOf(h.setup.profile.scaleKey)) };
}
