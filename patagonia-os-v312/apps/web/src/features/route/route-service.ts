import { supabase } from "../../lib/supabase";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listCustomersWithBalance } from "../customers/customers-service";
import { listTreasuryAccounts } from "../shifts/treasury-service";
import { listPriceLists } from "../pricing/price-lists-service";
import type { QueuedRouteSale, RouteCustomer, RouteProduct } from "./route-logic";

/** Venta en ruta (migración 161). Cada camión es una sucursal con is_vehicle. */

export interface Vehicle {
  id: string;
  name: string;
}

export interface Depot {
  id: string;
  name: string;
}

export interface RouteAccount {
  id: string;
  name: string;
  isCash: boolean;
  /** Cuenta propia del camión (su efectivo). */
  own: boolean;
}

/** Lo que el teléfono guarda para vender sin señal. */
export interface RouteCatalog {
  vehicleId: string;
  loadedAt: string;
  products: RouteProduct[];
  customers: RouteCustomer[];
  accounts: RouteAccount[];
}

function db() {
  if (!supabase) throw new Error("Sin conexión a la base");
  return supabase;
}

export async function listBranchesSplit(): Promise<{ vehicles: Vehicle[]; depots: Depot[] }> {
  const { data, error } = await db().from("branches").select("id,name,is_vehicle").eq("active", true).order("name");
  if (error) throw error;
  const rows = (data ?? []) as { id: string; name: string; is_vehicle: boolean }[];
  return {
    vehicles: rows.filter((r) => r.is_vehicle).map((r) => ({ id: r.id, name: r.name })),
    depots: rows.filter((r) => !r.is_vehicle).map((r) => ({ id: r.id, name: r.name }))
  };
}

export async function loadRouteCatalog(vehicleId: string): Promise<RouteCatalog> {
  const [products, customers, accounts, priceLists] = await Promise.all([
    listProductsForBranch(vehicleId),
    listCustomersWithBalance(),
    listTreasuryAccounts(vehicleId),
    listPriceLists().catch(() => [])
  ]);
  const activeListName = new Map(priceLists.filter((l) => l.active).map((l) => [l.id, l.name]));
  return {
    vehicleId,
    loadedAt: new Date().toISOString(),
    // El vendedor nunca ve el costo: no se guarda en el teléfono.
    products: products.map((p) => ({
      id: p.id, code: p.code, name: p.name, unit: p.unit === "kg" ? "kg" : "unit", price: p.priceRetail, stock: p.stock,
      ...(p.listPrices ? { listPrices: Object.fromEntries(Object.entries(p.listPrices).map(([id, v]) => [id, v.price])) } : {})
    })),
    customers: customers.filter((c) => c.active !== false).map((c) => ({ id: c.id, name: c.name, number: c.number, phone: c.phone, balance: c.balance,
      ...(c.priceListId && activeListName.has(c.priceListId) ? { priceListId: c.priceListId, priceListName: activeListName.get(c.priceListId) } : {}) })),
    accounts: accounts
      .filter((a) => !a.isSafe)
      .map((a) => ({ id: a.id, name: a.name, isCash: a.paymentMethod === "cash", own: a.branchId === vehicleId }))
      .sort((a, b) => Number(b.own) - Number(a.own))
  };
}

/** Sube una venta. Si ya se había subido (reintento), la base devuelve la misma. */
export async function sendRouteSale(sale: QueuedRouteSale): Promise<{ chargeId: string; total: number; balance: number }> {
  const { data, error } = await db().rpc("route_sale", {
    p_client_id: sale.clientId,
    p_vehicle: sale.vehicleId,
    p_customer_id: sale.customerId,
    p_items: sale.lines.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
    p_payments: sale.payments.filter((p) => p.amount > 0).map((p) => ({ account_id: p.accountId, amount: p.amount }))
  });
  if (error) throw error;
  const r = data as { charge_id: string; total: number; balance: number | null };
  return { chargeId: r.charge_id, total: Number(r.total), balance: Number(r.balance ?? 0) };
}

export async function createVehicle(name: string): Promise<string> {
  const { data, error } = await db().rpc("route_create_vehicle", { p_name: name });
  if (error) throw error;
  return data as string;
}

export async function loadVehicle(vehicleId: string, depotId: string, items: { productId: string; quantity: number }[]): Promise<number> {
  const { data, error } = await db().rpc("route_load_vehicle", {
    p_vehicle: vehicleId,
    p_depot: depotId,
    p_items: items.map((i) => ({ product_id: i.productId, quantity: i.quantity }))
  });
  if (error) throw error;
  return Number(data);
}

export interface VehicleStatus {
  since: string | null;
  stock: { productId: string; name: string; code: string; unit: "kg" | "unit"; cost: number; price: number; stock: number }[];
  accounts: { id: string; name: string; cash: boolean; balance: number }[];
  sales: { count: number; total: number; paid: number };
}

export async function getVehicleStatus(vehicleId: string): Promise<VehicleStatus> {
  const { data, error } = await db().rpc("route_vehicle_status", { p_vehicle: vehicleId });
  if (error) throw error;
  const r = data as VehicleStatus;
  return {
    since: r.since,
    stock: r.stock.map((s) => ({ ...s, unit: s.unit === "kg" ? "kg" : "unit", cost: Number(s.cost), price: Number(s.price), stock: Number(s.stock) })),
    accounts: r.accounts.map((a) => ({ ...a, balance: Number(a.balance) })),
    sales: { count: Number(r.sales.count), total: Number(r.sales.total), paid: Number(r.sales.paid) }
  };
}

export interface SettleResult {
  id: string;
  cashExpected: number;
  cashCounted: number;
  cashDifference: number;
  missingValue: number;
  salesCount: number;
  salesTotal: number;
  items: { productId: string; name: string; unit: string; had: number; returned: number; missing: number }[];
}

export async function settleVehicle(input: {
  vehicleId: string;
  depotId: string;
  returns: { productId: string; quantity: number }[];
  cashCounted: number;
  destAccountId: string | null;
  notes: string;
}): Promise<SettleResult> {
  const { data, error } = await db().rpc("route_settle", {
    p_vehicle: input.vehicleId,
    p_depot: input.depotId,
    p_returns: input.returns.map((r) => ({ product_id: r.productId, quantity: r.quantity })),
    p_cash_counted: input.cashCounted,
    p_dest_account: input.destAccountId,
    p_notes: input.notes || null
  });
  if (error) throw error;
  return data as SettleResult;
}

export interface Settlement {
  id: string;
  createdAt: string;
  cashExpected: number;
  cashCounted: number;
  cashDifference: number;
  missingValue: number;
  salesCount: number;
  salesTotal: number;
  onAccount: number;
  notes: string | null;
}

export async function listSettlements(vehicleId: string, limit = 20): Promise<Settlement[]> {
  const { data, error } = await db()
    .from("route_settlements")
    .select("id,created_at,cash_expected,cash_counted,cash_difference,missing_value,sales_count,sales_total,on_account,notes")
    .eq("vehicle_branch_id", vehicleId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    cashExpected: Number(r.cash_expected),
    cashCounted: Number(r.cash_counted),
    cashDifference: Number(r.cash_difference),
    missingValue: Number(r.missing_value),
    salesCount: Number(r.sales_count),
    salesTotal: Number(r.sales_total),
    onAccount: Number(r.on_account),
    notes: r.notes
  }));
}

// --- Guardado en el teléfono (sin señal) ---

const CATALOG_KEY = (vehicleId: string) => `patagonia-route-catalog-${vehicleId}`;
const QUEUE_KEY = "patagonia-route-queue";

export function readCachedCatalog(vehicleId: string): RouteCatalog | null {
  try {
    const raw = localStorage.getItem(CATALOG_KEY(vehicleId));
    return raw ? (JSON.parse(raw) as RouteCatalog) : null;
  } catch {
    return null;
  }
}

export function writeCachedCatalog(catalog: RouteCatalog) {
  try {
    localStorage.setItem(CATALOG_KEY(catalog.vehicleId), JSON.stringify(catalog));
  } catch {
    // sin lugar: se vuelve a bajar con señal
  }
}

export function readQueue(): QueuedRouteSale[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedRouteSale[]) : [];
  } catch {
    return [];
  }
}

/** Guarda la cola. Las ventas ya subidas quedan solo las últimas 30 (para reenviar el comprobante). */
export function writeQueue(queue: QueuedRouteSale[]): boolean {
  const pending = queue.filter((s) => s.status !== "sent");
  const sent = queue.filter((s) => s.status === "sent").slice(-30);
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify([...sent, ...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt))));
    return true;
  } catch {
    return false;
  }
}
