/**
 * Importe de cada artículo de un ticket de balanza Systel SIN hablar con la balanza al cobrar.
 *
 * El código de cada artículo trae producto + cantidad (exactos), pero no el precio que se cobró. El código
 * del TOTAL trae el importe total (y la cantidad de artículos). Con los dos precios de lista que tiene la
 * balanza para cada producto (función 62: lista 1 y lista 2) se busca qué precio se usó en cada artículo
 * para que la suma dé EXACTAMENTE el total.
 *
 * Por qué (REAL, Los gringos, 1.430 artículos del 07 al 13/10): 54 % se cobró a precio de lista 1, 42 % a
 * lista 2 (mayorista) y 4 % a otro precio. Usar un solo precio daría mal casi la mitad de los importes.
 * Con este método, en 860 de 861 tickets explicables el importe de cada artículo coincide con el de la
 * balanza (el otro: dos cajones a $74.000 y $70.000, precio manual; el total igual da bien).
 *
 * Resultado:
 * - "exacto": una sola combinación de precios explica el total → cada artículo con su importe.
 * - "proporcional": ninguna (precio manual o precio cambiado) o varias → el TOTAL se respeta y se reparte
 *   en proporción al precio de lista 1. Producto, cantidad, stock y total cobrado son exactos; solo el
 *   reparto del importe entre artículos es aproximado, y queda marcado.
 * - error: falta el precio de un producto o la cantidad de artículos no coincide.
 */

export interface SettleLine {
  /** Código del producto en la balanza. */
  plu: number;
  quantity: number;
}

export interface ScalePrices {
  /** Precio de lista 1 y 2 en pesos (0 = sin precio en esa lista). */
  p1: number;
  p2: number;
}

export type SettleResult =
  | { ok: true; method: "exacto" | "proporcional"; amounts: number[]; detail: string }
  | { ok: false; reason: string };

const MAX_COMBOS = 4096;

export function settleTicket(lines: SettleLine[], total: number, prices: Map<number, ScalePrices>, articles: number | null = null): SettleResult {
  if (lines.length === 0) return { ok: false, reason: "no hay artículos de la balanza escaneados antes del TOTAL" };
  if (articles !== null && articles !== lines.length) {
    return { ok: false, reason: `el TOTAL dice ${articles} artículos y se escanearon ${lines.length}` };
  }
  const options: number[][] = [];
  for (const l of lines) {
    const p = prices.get(l.plu);
    if (!p || !(p.p1 > 0)) return { ok: false, reason: `no se conoce el precio en la balanza del producto ${l.plu}` };
    const o = new Set<number>([Math.round(l.quantity * p.p1)]);
    if (p.p2 > 0) o.add(Math.round(l.quantity * p.p2));
    options.push([...o]);
  }
  const target = Math.round(total);
  const matches = new Set<string>();
  const combos = options.reduce((n, o) => n * o.length, 1);
  if (combos <= MAX_COMBOS) {
    const walk = (i: number, acc: number[], sum: number) => {
      if (matches.size > 1) return;
      if (i === options.length) {
        if (Math.abs(sum - target) <= 1) matches.add(acc.join(","));
        return;
      }
      for (const v of options[i]) walk(i + 1, [...acc, v], sum + v);
    };
    walk(0, [], 0);
  }
  if (matches.size === 1) {
    const amounts = [...matches][0].split(",").map(Number);
    // El redondeo de cada artículo puede dejar $1 de diferencia: va al último para que sume el total exacto.
    amounts[amounts.length - 1] += target - amounts.reduce((a, b) => a + b, 0);
    return { ok: true, method: "exacto", amounts, detail: "importe de cada artículo según el precio que usó la balanza" };
  }
  // Proporcional al precio de lista 1: el total es exacto, el reparto aproximado.
  const base = options.map((o) => o[0]);
  const sumBase = base.reduce((a, b) => a + b, 0);
  if (!(sumBase > 0)) return { ok: false, reason: "no se pudo repartir el total" };
  const amounts = base.map((b) => Math.round((b / sumBase) * target));
  amounts[amounts.length - 1] += target - amounts.reduce((a, b) => a + b, 0);
  return {
    ok: true,
    method: "proporcional",
    amounts,
    detail: matches.size > 1 ? "varias combinaciones de precios dan el total: se repartió en proporción" : "el total no coincide con los precios de lista (precio manual o cambiado): se repartió en proporción"
  };
}
