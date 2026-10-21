import { supabase } from "../../lib/supabase";

/** Reporte de cuentas y Gastos (migración 143, pantallas a pedido de Martínez).
 * Solo lee views/tablas que ya filtran por empresa (customer_balance,
 * supplier_balance, treasury_movements con RLS): no hay funciones nuevas. */

export interface AccountDebt {
  id: string;
  name: string;
  number?: number;
  balance: number;
  active: boolean;
}

/** Clientes con saldo a cobrar (≥ $1), de mayor a menor. Incluye los dados de baja que todavía deben. */
export async function listCustomerDebts(): Promise<AccountDebt[]> {
  if (!supabase) return [];
  const [balances, customers] = await Promise.all([
    supabase.from("customer_balance").select("customer_id,balance"),
    supabase.from("customers").select("id,number,name,active")
  ]);
  if (balances.error) throw balances.error;
  if (customers.error) throw customers.error;
  const byId = new Map((customers.data ?? []).map((c) => [c.id as string, c]));
  return (balances.data ?? [])
    .map((row) => {
      const c = byId.get(row.customer_id as string);
      return {
        id: row.customer_id as string,
        name: (c?.name as string | undefined) ?? "Cliente",
        number: (c?.number as number | null | undefined) ?? undefined,
        balance: Number(row.balance),
        active: Boolean(c?.active ?? true)
      };
    })
    .filter((d) => d.balance >= 1)
    .sort((a, b) => b.balance - a.balance);
}

/** Proveedores a los que se les debe (≥ $1), de mayor a menor. */
export async function listSupplierDebts(): Promise<AccountDebt[]> {
  if (!supabase) return [];
  const [balances, suppliers] = await Promise.all([
    supabase.from("supplier_balance").select("supplier_id,balance"),
    supabase.from("suppliers").select("id,name,active")
  ]);
  if (balances.error) throw balances.error;
  if (suppliers.error) throw suppliers.error;
  const byId = new Map((suppliers.data ?? []).map((s) => [s.id as string, s]));
  return (balances.data ?? [])
    .map((row) => {
      const s = byId.get(row.supplier_id as string);
      return {
        id: row.supplier_id as string,
        name: (s?.name as string | undefined) ?? "Proveedor",
        balance: Number(row.balance),
        active: Boolean(s?.active ?? true)
      };
    })
    .filter((d) => d.balance >= 1)
    .sort((a, b) => b.balance - a.balance);
}

export interface ExpenseRow {
  id: string;
  date: string;
  category: string;
  description: string;
  accountName: string;
  amount: number;
}

/** Gastos (treasury_movements 'gasto', los de "Registrar gasto") entre dos fechas, de todas las sucursales. */
export async function listExpenses(from: string, to: string): Promise<ExpenseRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("treasury_movements")
    .select("id,amount,category,occurred_on,notes,treasury_accounts(name)")
    .eq("movement_type", "gasto")
    .gte("occurred_on", from)
    .lte("occurred_on", to)
    .order("occurred_on", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw error;
  type Row = { id: string; amount: number; category: string | null; occurred_on: string; notes: string | null; treasury_accounts: { name: string } | { name: string }[] | null };
  return ((data ?? []) as unknown as Row[]).map((row) => {
    const account = Array.isArray(row.treasury_accounts) ? row.treasury_accounts[0] : row.treasury_accounts;
    return {
      id: row.id,
      date: row.occurred_on,
      category: row.category ?? "otro",
      description: row.notes ?? "",
      accountName: account?.name ?? "-",
      amount: Number(row.amount)
    };
  });
}
