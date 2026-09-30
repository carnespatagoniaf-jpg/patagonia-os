/**
 * Cruce automático entre las líneas del resumen del banco y los movimientos
 * de Tesorería de esa cuenta. Solo SUGIERE: la persona confirma. Lógica pura
 * (sin Supabase) para poder testearla.
 *
 * Dos casos reales:
 * 1) Uno a uno: una transferencia, un pago a proveedor, un gasto — mismo
 *    importe exacto, fecha cercana.
 * 2) Muchos a uno: el posnet deposita todas las ventas con tarjeta de un día
 *    juntas, varios días después y con la comisión ya descontada. En
 *    Tesorería cada venta es un movimiento. Se busca el día cuyas ventas
 *    suman el depósito (exacto, o un poco más: la diferencia es la comisión).
 */

export interface MatchLine {
  id: string;
  date: string;
  /** Positivo = entró plata, negativo = salió. */
  amount: number;
  description: string;
}

export interface MatchMovement {
  id: string;
  date: string;
  direction: "in" | "out";
  amount: number;
  movementType: string;
}

export type SuggestionKind = "exact" | "day_total" | "day_total_fee";

export interface MatchSuggestion {
  lineId: string;
  movementIds: string[];
  kind: SuggestionKind;
  /** Suma de los movimientos sugeridos (positivo). */
  movementsTotal: number;
  /** Diferencia que queda como comisión/retención (solo day_total_fee). */
  fee: number;
}

/** Días hacia atrás que se miran para un depósito de tarjetas (acreditación en ~18 días hábiles). */
export const CARD_SETTLEMENT_MAX_DAYS = 35;
/** Tope de la comisión+retenciones que se acepta como "posible" (sobre lo vendido). */
export const MAX_FEE_RATIO = 0.12;

function toDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function cents(n: number): number {
  return Math.round(n * 100);
}

function signed(m: MatchMovement): number {
  return m.direction === "in" ? m.amount : -m.amount;
}

export function suggestMatches(lines: MatchLine[], movements: MatchMovement[]): MatchSuggestion[] {
  const suggestions: MatchSuggestion[] = [];
  const usedMovements = new Set<string>();
  const matchedLines = new Set<string>();

  // 1) Uno a uno, importe exacto. La fecha del banco puede ser igual o
  //    posterior (acreditación), rara vez anterior: de 3 días antes a 35 después.
  const sortedLines = [...lines].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const line of sortedLines) {
    const lineDay = toDay(line.date);
    const lineCents = cents(line.amount);
    let best: MatchMovement | null = null;
    let bestDistance = Infinity;
    for (const mov of movements) {
      if (usedMovements.has(mov.id) || cents(signed(mov)) !== lineCents) continue;
      const lag = lineDay - toDay(mov.date);
      if (lag < -3 || lag > CARD_SETTLEMENT_MAX_DAYS) continue;
      const distance = Math.abs(lag);
      if (distance < bestDistance || (distance === bestDistance && best && mov.date < best.date)) {
        best = mov;
        bestDistance = distance;
      }
    }
    if (best) {
      usedMovements.add(best.id);
      matchedLines.add(line.id);
      suggestions.push({ lineId: line.id, movementIds: [best.id], kind: "exact", movementsTotal: best.amount, fee: 0 });
    }
  }

  // 2) Depósitos (entradas) contra el total de ventas de un mismo día.
  const salesByDay = new Map<string, MatchMovement[]>();
  for (const mov of movements) {
    if (usedMovements.has(mov.id) || mov.direction !== "in" || mov.movementType !== "venta") continue;
    const list = salesByDay.get(mov.date) ?? [];
    list.push(mov);
    salesByDay.set(mov.date, list);
  }

  for (const line of sortedLines) {
    if (matchedLines.has(line.id) || line.amount <= 0) continue;
    const lineDay = toDay(line.date);
    const lineCents = cents(line.amount);
    let best: { day: string; movs: MatchMovement[]; totalCents: number } | null = null;
    for (const [day, movs] of salesByDay) {
      const lag = lineDay - toDay(day);
      if (lag < 0 || lag > CARD_SETTLEMENT_MAX_DAYS) continue;
      const available = movs.filter((m) => !usedMovements.has(m.id));
      if (available.length < 2) continue;
      const totalCents = available.reduce((sum, m) => sum + cents(m.amount), 0);
      const feeCents = totalCents - lineCents;
      if (feeCents < 0 || feeCents > totalCents * MAX_FEE_RATIO) continue;
      // Preferir el que coincide exacto; si no, el de menor comisión; si empatan, el día más cercano.
      if (
        !best ||
        feeCents < best.totalCents - lineCents ||
        (feeCents === best.totalCents - lineCents && day > best.day)
      ) {
        best = { day, movs: available, totalCents };
      }
    }
    if (best) {
      for (const m of best.movs) usedMovements.add(m.id);
      matchedLines.add(line.id);
      const fee = (best.totalCents - lineCents) / 100;
      suggestions.push({
        lineId: line.id,
        movementIds: best.movs.map((m) => m.id),
        kind: fee === 0 ? "day_total" : "day_total_fee",
        movementsTotal: best.totalCents / 100,
        fee
      });
    }
  }

  return suggestions;
}

/** Días que lleva un movimiento sin aparecer en el banco (para "pendiente de acreditación"). */
export function daysWaiting(movementDate: string, today: string): number {
  return Math.max(0, Math.round(toDay(today) - toDay(movementDate)));
}
