import { useCallback, useEffect, useState } from "react";
import type { CarcassBatch, CarcassCut } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import {
  deleteCarcassBatch,
  deleteCarcassCut,
  listCarcassBatches,
  listCarcassCuts,
  saveCarcassBatch,
  saveCarcassCut,
  type SaveCarcassBatchInput,
  type SaveCarcassCutInput
} from "./carcass-service";

export function useCarcass() {
  const { branchId } = useActiveBranch();

  const [batches, setBatches] = useState<CarcassBatch[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const [cuts, setCuts] = useState<CarcassCut[]>([]);
  const [cutsLoading, setCutsLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured || !branchId) return;
    setLoading(true);
    setError(null);
    try {
      setBatches(await listCarcassBatches(branchId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las reses.");
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadCuts = useCallback(async (batchId: string) => {
    if (!isSupabaseConfigured) return;
    setCutsLoading(true);
    try {
      setCuts(await listCarcassCuts(batchId));
    } finally {
      setCutsLoading(false);
    }
  }, []);

  const saveBatch = useCallback(
    async (input: Omit<SaveCarcassBatchInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");
      if (!isSupabaseConfigured) throw new Error("Configurá Supabase para usar el despiece.");

      const result = await saveCarcassBatch({ ...input, branchId });
      await reload();
      return result;
    },
    [branchId, reload]
  );

  const removeBatch = useCallback(
    async (batchId: string) => {
      await deleteCarcassBatch(batchId);
      await reload();
    },
    [reload]
  );

  const saveCut = useCallback(
    async (input: SaveCarcassCutInput) => {
      const result = await saveCarcassCut(input);
      await loadCuts(input.batchId);
      return result;
    },
    [loadCuts]
  );

  const removeCut = useCallback(
    async (cutId: string, batchId: string) => {
      await deleteCarcassCut(cutId);
      await loadCuts(batchId);
    },
    [loadCuts]
  );

  return {
    branchId,
    batches,
    loading,
    error,
    reload,
    cuts,
    cutsLoading,
    loadCuts,
    saveBatch,
    removeBatch,
    saveCut,
    removeCut
  };
}
