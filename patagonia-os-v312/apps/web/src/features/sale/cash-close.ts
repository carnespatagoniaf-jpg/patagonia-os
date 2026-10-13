// Cierre de caja a ciegas por medio de pago (migración 117). Lógica pura,
// sin Supabase, para poder probarla: armar lo que declaró la cajera, decidir
// si "da bien" y adivinar ventas cobradas con el medio de pago equivocado
// (ej. cobrada en efectivo y marcada como transferencia: sobra efectivo y
// falta transferencia por el mismo monto).

/** Diferencia que se considera "da bien" (vuelto, redondeos). Los cierres
 * reales del turno tarde de Haedo dan entre −$1.300 y +$550. */
export const CLOSE_OK_TOLERANCE = 500;

export interface CountRow {
  accountId: string;
  name: string;
  paymentMethod: string | null;
  /** null = no lo informó. */
  declared: number | null;
  expected: number;
  difference: number | null;
  salesCount: number;
}

export interface CountResult {
  attempt: number;
  cashDeclared: number;
  cashExpected: number;
  cashDifference: number;
  /** Diferencia de efectivo del PRIMER conteo del turno (la que ve el dueño). */
  firstCashDifference: number;
  openingCash: number;
  cashSales: number;
  /** Retiros, vales, pagos e ingresos en efectivo del turno (con signo). */
  cashMovements: number;
  accounts: CountRow[];
}

export interface SalePaymentRef {
  saleId: string;
  paymentId: string;
  accountId: string;
  amount: number;
  createdAt: string;
}

export interface SwapSuggestion {
  /** Cuenta con la que se marcó la venta (le falta plata). */
  fromAccountId: string;
  fromName: string;
  /** Cuenta donde está la plata de verdad (le sobra). */
  toAccountId: string;
  toName: string;
  amount: number;
  candidates: SalePaymentRef[];
}

export type DeclaredInput = { cash: string; accounts: Record<string, string> };

export interface DeclaredPayload {
  cash: number;
  accounts: { account_id: string; amount: number }[];
}

/** Arma lo que se manda a check_pos_shift_count. `parse` es parseAmount
 * (formato argentino). Devuelve el error a mostrar si falta algo. */
export function buildDeclared(
  input: DeclaredInput,
  accountIds: string[],
  parse: (value: string) => number
): { payload: DeclaredPayload } | { error: string } {
  if (!input.cash.trim()) return { error: "Contá la plata del cajón y anotá cuánto hay." };
  const cash = parse(input.cash);
  if (!Number.isFinite(cash) || cash < 0) return { error: "El efectivo contado no es un número válido." };
  const accounts: DeclaredPayload["accounts"] = [];
  for (const id of accountIds) {
    const raw = (input.accounts[id] ?? "").trim();
    if (!raw) return { error: "Completá el total de cada medio de pago (si no hubo nada, poné 0)." };
    const amount = parse(raw);
    if (!Number.isFinite(amount) || amount < 0) return { error: "Hay un total que no es un número válido." };
    accounts.push({ account_id: id, amount });
  }
  return { payload: { cash, accounts } };
}

export function isOk(difference: number | null, tolerance = CLOSE_OK_TOLERANCE): boolean {
  return difference !== null && Math.abs(difference) <= tolerance;
}

/** ¿Todo da bien? (efectivo y cada medio informado). */
export function countIsOk(result: CountResult, tolerance = CLOSE_OK_TOLERANCE): boolean {
  if (!isOk(result.cashDifference, tolerance)) return false;
  return result.accounts.every((row) => row.difference === null ? row.expected === 0 : isOk(row.difference, tolerance));
}

function swapWindow(amount: number): number {
  return Math.max(CLOSE_OK_TOLERANCE, Math.abs(amount) * 0.02);
}

/**
 * Pares de cuentas donde a una le sobra y a otra le falta casi lo mismo, con
 * las ventas de la cuenta que falta cuyo monto se parece a esa diferencia.
 * `cashAccountId` es la cuenta de efectivo de Mostrador (la fila de efectivo
 * del conteo no trae id porque junta todas las cuentas de efectivo).
 */
export function findPaymentSwaps(
  result: CountResult,
  payments: SalePaymentRef[],
  cash: { accountId: string | null; name: string }
): SwapSuggestion[] {
  type Line = { accountId: string; name: string; difference: number; isCash: boolean };
  const lines: Line[] = [];
  if (cash.accountId) lines.push({ accountId: cash.accountId, name: cash.name, difference: result.cashDifference, isCash: true });
  for (const row of result.accounts) {
    if (row.difference !== null) lines.push({ accountId: row.accountId, name: row.name, difference: row.difference, isCash: false });
  }

  const suggestions: SwapSuggestion[] = [];
  for (const over of lines.filter((l) => l.difference > CLOSE_OK_TOLERANCE)) {
    for (const short of lines.filter((l) => l.difference < -CLOSE_OK_TOLERANCE)) {
      const amount = Math.min(over.difference, -short.difference);
      if (Math.abs(over.difference + short.difference) > swapWindow(amount)) continue;
      const window = swapWindow(amount);
      const candidates = payments
        .filter((p) => p.accountId === short.accountId && Math.abs(p.amount - amount) <= window)
        .sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount));
      suggestions.push({
        fromAccountId: short.accountId,
        fromName: short.name,
        toAccountId: over.accountId,
        toName: over.name,
        amount,
        candidates
      });
    }
  }
  return suggestions.sort((a, b) => b.amount - a.amount);
}

/** Convierte la respuesta cruda del RPC. */
export function parseCountResult(data: Record<string, unknown>): CountResult {
  const num = (v: unknown) => Number(v ?? 0);
  const accounts = Array.isArray(data.accounts) ? (data.accounts as Record<string, unknown>[]) : [];
  return {
    attempt: num(data.attempt),
    cashDeclared: num(data.cash_declared),
    cashExpected: num(data.cash_expected),
    cashDifference: num(data.cash_difference),
    firstCashDifference: num(data.first_cash_difference),
    openingCash: num(data.opening_cash),
    cashSales: num(data.cash_sales),
    cashMovements: num(data.cash_movements),
    accounts: accounts.map((row) => ({
      accountId: String(row.account_id),
      name: String(row.name ?? ""),
      paymentMethod: (row.payment_method as string | null) ?? null,
      declared: row.declared === null || row.declared === undefined ? null : num(row.declared),
      expected: num(row.expected),
      difference: row.difference === null || row.difference === undefined ? null : num(row.difference),
      salesCount: num(row.sales_count)
    }))
  };
}
