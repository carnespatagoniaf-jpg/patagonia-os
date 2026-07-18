import type { Supplier } from "@patagonia/domain";
import { supabase } from "../../lib/supabase";

interface SupplierRow {
  id: string;
  name: string;
  category: string;
  phone: string | null;
  notes: string | null;
  active: boolean;
}

function mapSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    phone: row.phone ?? undefined,
    notes: row.notes ?? undefined,
    active: row.active
  };
}

export async function listSuppliers(): Promise<Supplier[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("suppliers")
    .select("id,name,category,phone,notes,active")
    .eq("active", true)
    .order("name");

  if (error) throw error;
  return (data ?? []).map(mapSupplier);
}

export interface CreateSupplierInput {
  name: string;
  category: string;
  phone?: string;
  notes?: string;
}

export async function createSupplier(input: CreateSupplierInput): Promise<Supplier> {
  if (!supabase) throw new Error("Supabase no está configurado.");

  const { data, error } = await supabase.rpc("create_supplier", {
    p_name: input.name,
    p_category: input.category,
    p_phone: input.phone ?? null,
    p_notes: input.notes ?? null
  });

  if (error) throw error;
  return { id: data.id, name: data.name, category: data.category, active: true };
}

export interface SupplierBalance {
  supplierId: string;
  totalPurchases: number;
  totalPayments: number;
  balance: number;
}

export async function fetchSupplierBalance(supplierId: string): Promise<SupplierBalance | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("supplier_balance")
    .select("supplier_id,total_purchases,total_payments,balance")
    .eq("supplier_id", supplierId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    supplierId: data.supplier_id,
    totalPurchases: Number(data.total_purchases),
    totalPayments: Number(data.total_payments),
    balance: Number(data.balance)
  };
}
