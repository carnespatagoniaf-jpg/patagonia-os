import { useCallback, useEffect, useState } from "react";
import type { Supplier } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { createSupplier, listSuppliers, type CreateSupplierInput } from "./suppliers-service";

const DEMO_SUPPLIERS: Supplier[] = [
  { id: "demo-supplier-1", name: "Avícola San José (demo)", category: "pollo", active: true },
  { id: "demo-supplier-2", name: "Frigorífico Sur (demo)", category: "carne", active: true }
];

export function useSuppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>(isSupabaseConfigured ? [] : DEMO_SUPPLIERS);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;

    setLoading(true);
    setError(null);
    try {
      setSuppliers(await listSuppliers());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los proveedores.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (input: CreateSupplierInput) => {
      if (!isSupabaseConfigured) {
        const supplier: Supplier = { id: crypto.randomUUID(), active: true, ...input };
        setSuppliers((current) => [...current, supplier]);
        return supplier;
      }

      const supplier = await createSupplier(input);
      await reload();
      return supplier;
    },
    [reload]
  );

  return { suppliers, loading, error, create, reload };
}
