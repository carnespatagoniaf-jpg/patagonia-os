import { supabase } from "../../lib/supabase";
import type { CustomerOrder, OrderDraftItem, OrderStatus, OrderUnit } from "./orders-logic";

// Pedidos de clientes (migración 187). Se lee directo de las tablas (RLS: empresa + sucursal + pantalla 'pedidos')
// y se escribe solo por RPC (migración 175). Sin Supabase (modo demostración) se guarda en este navegador.

interface OrderRow {
  id: string;
  branch_id: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  pickup_date: string;
  pickup_time: string | null;
  notes: string | null;
  total: number | string | null;
  deposit: number | string;
  status: OrderStatus;
  created_at: string;
  customer_order_items: Array<{
    product_id: string;
    quantity: number | string;
    unit: OrderUnit;
    notes: string | null;
    position: number;
    products: { name: string } | null;
  }> | null;
}

/** Base sin la migración 187 (o sin la pantalla): la web sigue andando, sin pedidos. */
function missingTable(error: { code?: string } | null): boolean {
  return !!error && (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST200");
}

function fromRow(r: OrderRow): CustomerOrder {
  return {
    id: r.id,
    branchId: r.branch_id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    pickupDate: r.pickup_date,
    pickupTime: r.pickup_time ? r.pickup_time.slice(0, 5) : null,
    notes: r.notes,
    total: r.total === null ? null : Number(r.total),
    deposit: Number(r.deposit ?? 0),
    status: r.status,
    createdAt: r.created_at,
    items: [...(r.customer_order_items ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((i) => ({
        productId: i.product_id,
        productName: i.products?.name ?? "Producto",
        quantity: Number(i.quantity),
        unit: i.unit,
        notes: i.notes
      }))
  };
}

const SELECT =
  "id,branch_id,customer_id,customer_name,customer_phone,pickup_date,pickup_time,notes,total,deposit,status,created_at," +
  "customer_order_items(product_id,quantity,unit,notes,position,products(name))";

/** Pedidos entre dos días (inclusive). branchId null = todas las sucursales que la persona puede ver. */
export async function listOrders(branchId: string | null, from: string, to: string): Promise<CustomerOrder[]> {
  if (!supabase) return demoList().filter((o) => (!branchId || o.branchId === branchId) && o.pickupDate >= from && o.pickupDate <= to);
  let query = supabase.from("customer_orders").select(SELECT).gte("pickup_date", from).lte("pickup_date", to).order("pickup_date").limit(2000);
  if (branchId) query = query.eq("branch_id", branchId);
  const { data, error } = await query;
  if (missingTable(error)) return [];
  if (error) throw error;
  return ((data ?? []) as unknown as OrderRow[]).map(fromRow);
}

/** Pedidos abiertos (pendientes o listos) de días anteriores: los que se quedaron sin entregar. */
export async function listOverdueBefore(branchId: string | null, before: string): Promise<CustomerOrder[]> {
  if (!supabase) return demoList().filter((o) => (!branchId || o.branchId === branchId) && o.pickupDate < before && (o.status === "pendiente" || o.status === "listo"));
  let query = supabase.from("customer_orders").select(SELECT).lt("pickup_date", before).in("status", ["pendiente", "listo"]).order("pickup_date").limit(200);
  if (branchId) query = query.eq("branch_id", branchId);
  const { data, error } = await query;
  if (missingTable(error)) return [];
  if (error) throw error;
  return ((data ?? []) as unknown as OrderRow[]).map(fromRow);
}

export interface OrderInput {
  id: string | null;
  branchId: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  pickupDate: string;
  pickupTime: string;
  notes: string;
  total: number | null;
  deposit: number;
  items: OrderDraftItem[];
}

export async function saveOrder(input: OrderInput): Promise<string> {
  const items = input.items.filter((i) => i.quantity > 0);
  if (!supabase) return demoSave(input, items);
  const { data, error } = await supabase.rpc("save_customer_order", {
    p_id: input.id,
    p_branch_id: input.branchId,
    p_customer_id: input.customerId,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    p_pickup_date: input.pickupDate,
    p_pickup_time: input.pickupTime || null,
    p_notes: input.notes,
    p_total: input.total,
    p_deposit: input.deposit,
    p_items: items.map((i) => ({ product_id: i.productId, quantity: i.quantity, notes: i.notes.trim() || null }))
  });
  if (error) throw error;
  return String(data);
}

export async function setOrderStatus(id: string, status: OrderStatus): Promise<void> {
  if (!supabase) {
    demoWrite(demoList().map((o) => (o.id === id ? { ...o, status } : o)));
    return;
  }
  const { error } = await supabase.rpc("set_customer_order_status", { p_id: id, p_status: status });
  if (error) throw error;
}

// Modo demostración ---------------------------------------------------------

const DEMO_KEY = "patagonia-demo-orders";

function demoList(): CustomerOrder[] {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    return raw ? (JSON.parse(raw) as CustomerOrder[]) : [];
  } catch {
    return [];
  }
}

function demoWrite(orders: CustomerOrder[]): void {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(orders));
  } catch {
    // sin localStorage no se guarda (solo demostración)
  }
}

function demoSave(input: OrderInput, items: OrderDraftItem[]): string {
  const orders = demoList();
  const id = input.id ?? `demo-${Date.now()}`;
  const previous = orders.find((o) => o.id === id);
  const order: CustomerOrder = {
    id,
    branchId: input.branchId,
    customerId: input.customerId,
    customerName: input.customerName.trim(),
    customerPhone: input.customerPhone.trim() || null,
    pickupDate: input.pickupDate,
    pickupTime: input.pickupTime || null,
    notes: input.notes.trim() || null,
    total: input.total,
    deposit: input.deposit,
    status: previous?.status ?? "pendiente",
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    items: items.map((i) => ({ productId: i.productId, productName: i.productName, quantity: i.quantity, unit: i.unit, notes: i.notes.trim() || null }))
  };
  demoWrite(previous ? orders.map((o) => (o.id === id ? order : o)) : [...orders, order]);
  return id;
}
