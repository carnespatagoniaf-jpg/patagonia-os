/**
 * Cruce automático entre las líneas del resumen del banco y el lado "sistema"
 * de esa cuenta del banco. Solo SUGIERE: la persona confirma. Lógica pura
 * (sin Supabase) para poder testearla.
 *
 * Diseñado con un resumen REAL (Banco Provincia, septiembre 2026, 1.227
 * líneas) contra los cobros reales de Mostrador:
 * - Transferencias: el banco trae cada una suelta y Mostrador guarda cada
 *   cobro suelto (pos_sale_payments) → uno a uno, mismo importe, de 3 días
 *   antes a 7 después. En el caso real cruzaron 258 de 321 (80%).
 * - Tarjetas: el banco acredita por lote, por marca, días hábiles después y
 *   con la comisión descontada ("PAGOS A COMERCIOS VISA - L. …"). No se
 *   cruzan venta por venta: se muestran por período (vendido vs acreditado).
 * - Pagos a proveedores, gastos, etc.: movimientos de Tesorería, uno a uno.
 */

export interface MatchLine {
  id: string;
  date: string;
  /** Positivo = entró plata, negativo = salió. */
  amount: number;
  description: string;
}

export interface SystemItem {
  id: string;
  /** "payment" = cobro de Mostrador; "movement" = movimiento de Tesorería. */
  source: "payment" | "movement";
  date: string;
  /** Con signo, como lo vería el banco: cobros y entradas positivos, salidas negativas. */
  amount: number;
  /** Cobro con tarjeta (cuenta marcada como posnet): no se cruza uno a uno. */
  isCard: boolean;
  label: string;
}

export interface MatchSuggestion {
  lineId: string;
  itemIds: string[];
  kind: "exact";
}

export const MAX_DAYS_BEFORE = 3;
export const MAX_DAYS_AFTER = 7;

const CARD_DEPOSIT = /pagos? a comercios|liquidaci[oó]n|\bliq\b|acred.*(visa|master|cabal|amex|naranja|maestro|d[eé]bito|cr[eé]dito)|prisma|first ?data|fiserv|getnet|payway|posnet|lapos|clover/i;
const TAX = /\bimp(uesto)?\b|ley\s*25\.?413|\biibb\b|ingresos brutos|sellos|percep|retenc|\biva\b|ganancias|sircreb/i;

export function isCardDeposit(line: Pick<MatchLine, "amount" | "description">): boolean {
  return line.amount > 0 && CARD_DEPOSIT.test(line.description);
}

export function isTaxLine(line: Pick<MatchLine, "amount" | "description">): boolean {
  return line.amount < 0 && TAX.test(line.description);
}

function toDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

const cents = (n: number) => Math.round(n * 100);

/**
 * Uno a uno: mismo importe al centavo y mismo signo. Entre varios candidatos,
 * el de fecha más cercana (a igual distancia, mejor "el banco igual o después").
 * Las acreditaciones de tarjeta y los cobros con tarjeta no participan.
 */
export function suggestMatches(lines: MatchLine[], items: SystemItem[]): MatchSuggestion[] {
  const used = new Set<string>();
  const byAmount = new Map<number, SystemItem[]>();
  for (const item of items) {
    if (item.isCard) continue;
    const key = cents(item.amount);
    const list = byAmount.get(key) ?? [];
    list.push(item);
    byAmount.set(key, list);
  }

  const suggestions: MatchSuggestion[] = [];
  const sorted = [...lines].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const line of sorted) {
    if (isCardDeposit(line)) continue;
    const candidates = byAmount.get(cents(line.amount));
    if (!candidates) continue;
    const lineDay = toDay(line.date);
    let best: SystemItem | null = null;
    let bestScore = Infinity;
    for (const item of candidates) {
      if (used.has(item.id)) continue;
      const lag = lineDay - toDay(item.date); // positivo: el banco lo muestra después
      if (lag < -MAX_DAYS_BEFORE || lag > MAX_DAYS_AFTER) continue;
      const score = lag >= 0 ? lag : 0.5 - lag;
      if (score < bestScore || (score === bestScore && best && item.date < best.date)) {
        best = item;
        bestScore = score;
      }
    }
    if (best) {
      used.add(best.id);
      suggestions.push({ lineId: line.id, itemIds: [best.id], kind: "exact" });
    }
  }
  return suggestions;
}

export interface CardSummary {
  sold: number;
  soldCount: number;
  deposited: number;
  depositCount: number;
  /** vendido − acreditado: comisiones y retenciones + lo que todavía no se acreditó. */
  difference: number;
  /** Diferencia sobre lo vendido (si todo ya se acreditó, es el costo de las tarjetas). */
  differencePct: number | null;
}

export function summarizeCards(cardItems: SystemItem[], depositLines: MatchLine[]): CardSummary {
  const sold = Math.round(cardItems.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  const deposited = Math.round(depositLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const difference = Math.round((sold - deposited) * 100) / 100;
  return {
    sold,
    soldCount: cardItems.length,
    deposited,
    depositCount: depositLines.length,
    difference,
    differencePct: sold > 0 ? Math.round((difference / sold) * 1000) / 10 : null
  };
}

/**
 * Agrupa líneas "iguales" que están en el banco y no en el sistema (ej. los 89
 * "IMPUESTO CREDITO -LEY 25413" del mes) para cargarlas de una vez. Se agrupa
 * por las primeras palabras del texto, sin números.
 */
export function groupSimilarLines<T extends MatchLine>(lines: T[], minSize = 3): { label: string; lines: T[]; total: number }[] {
  const groups = new Map<string, T[]>();
  for (const line of lines) {
    const label = line.description.replace(/[0-9]+/g, " ").replace(/[^\p{L}]+/gu, " ").trim().toUpperCase().split(" ").slice(0, 4).join(" ");
    if (!label) continue;
    const key = `${line.amount < 0 ? "-" : "+"}${label}`;
    const list = groups.get(key) ?? [];
    list.push(line);
    groups.set(key, list);
  }
  return Array.from(groups.entries())
    .filter(([, list]) => list.length >= minSize)
    .map(([key, list]) => ({ label: key.slice(1), lines: list, total: Math.round(list.reduce((s, l) => s + l.amount, 0) * 100) / 100 }))
    .sort((a, b) => b.lines.length - a.lines.length);
}

/** Días que lleva algo del sistema sin aparecer en el banco. */
export function daysWaiting(date: string, today: string): number {
  return Math.max(0, Math.round(toDay(today) - toDay(date)));
}
