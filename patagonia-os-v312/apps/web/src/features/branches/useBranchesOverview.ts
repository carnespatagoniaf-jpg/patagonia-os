import { useCallback, useEffect, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { getBranchesOverview, transferBranchStock, type BranchOverview, type TransferBranchStockInput } from "./branches-overview-service";

export function useBranchesOverview() {
  const [branches, setBranches] = useState<BranchOverview[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    setError(null);
    try {
      setBranches(await getBranchesOverview());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el resumen de sucursales.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const transfer = useCallback(
    async (input: TransferBranchStockInput) => {
      const result = await transferBranchStock(input);
      await reload();
      return result;
    },
    [reload]
  );

  return { branches, loading, error, transfer, reload };
}
