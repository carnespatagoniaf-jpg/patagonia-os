import { isOverdueDebt } from "@patagonia/domain";

/** Lógica pura de la lista de Clientes (buscar, filtrar, ordenar). Sin
 * imports de lib/supabase para poder testearla. */

export type CustomerStatus = "overdue" | "owes" | "clear";
export type CustomerFilter = "all" | "owes" | "overdue" | "clear";

export interface CustomerListItem {
  name: string;
  number?: number;
  phone?: string;
  locality?: string;
  balance: number;
  paymentTermDays?: number;
  lastActivityDate?: string;
}

/** "Al día" incluye saldo 0 o a favor; "Debe" es saldo positivo; "Atrasado"
 * es debe y pasó el plazo de pago (isOverdueDebt). Menos de $1 cuenta como 0
 * para que un redondeo no deje a alguien marcado como deudor. */
export function customerStatus(c: CustomerListItem, todayIso: string): CustomerStatus {
  if (c.balance < 1) return "clear";
  return isOverdueDebt(c, todayIso) ? "overdue" : "owes";
}

function normalize(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Busca por número ("12" o "#12"), nombre (sin importar tildes), teléfono
 * (solo dígitos) o localidad. */
export function matchesCustomerSearch(c: CustomerListItem, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;

  const asNumber = q.replace(/^(#|n[º°o]?\.?\s*)/, "");
  if (/^\d+$/.test(asNumber) && c.number !== undefined && String(c.number) === asNumber) return true;

  if (normalize(c.name).includes(q)) return true;
  if (c.locality && normalize(c.locality).includes(q)) return true;

  const digits = q.replace(/\D/g, "");
  if (digits.length >= 3 && c.phone && c.phone.replace(/\D/g, "").includes(digits)) return true;

  return false;
}

const STATUS_ORDER: Record<CustomerStatus, number> = { overdue: 0, owes: 1, clear: 2 };

/** Primero los atrasados, después los que deben (más deuda arriba), al final
 * los que están al día (por nombre). */
export function filterAndSortCustomers<T extends CustomerListItem>(
  list: T[],
  query: string,
  filter: CustomerFilter,
  todayIso: string
): T[] {
  return list
    .map((c) => ({ c, status: customerStatus(c, todayIso) }))
    .filter(({ c, status }) => {
      if (!matchesCustomerSearch(c, query)) return false;
      if (filter === "all") return true;
      if (filter === "owes") return status !== "clear";
      return status === filter;
    })
    .sort((a, b) => {
      const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (byStatus !== 0) return byStatus;
      if (a.status !== "clear" && b.c.balance !== a.c.balance) return b.c.balance - a.c.balance;
      return a.c.name.localeCompare(b.c.name, "es");
    })
    .map(({ c }) => c);
}

export function countByStatus(list: CustomerListItem[], todayIso: string) {
  const counts = { all: list.length, owes: 0, overdue: 0, clear: 0 };
  for (const c of list) {
    const status = customerStatus(c, todayIso);
    if (status === "clear") counts.clear += 1;
    else {
      counts.owes += 1;
      if (status === "overdue") counts.overdue += 1;
    }
  }
  return counts;
}
