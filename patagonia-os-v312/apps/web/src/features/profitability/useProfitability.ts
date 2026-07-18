import { useCallback, useEffect, useState } from "react";
import type { FixedCost, ProfitabilityPeriod, StockCount } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import {
  closeProfitabilityPeriod,
  createFixedCost,
  deleteStockCount,
  getPurchasesTotalInRange,
  getStockTotalNearDate,
  listFixedCosts,
  listProfitabilityPeriods,
  listPurchasedProductsInRange,
  listStockCounts,
  saveStockCount,
  updateFixedCost,
  type ClosePeriodInput,
  type CreateFixedCostInput,
  type PurchasedProductRanking,
  type SaveStockCountInput,
  type UpdateFixedCostInput
} from "./profitability-service";

const DEMO_BRANCH_ID = "demo-branch";

const DEMO_FIXED_COSTS: FixedCost[] = [
  { id: "demo-fc-1", branchId: DEMO_BRANCH_ID, name: "Alquiler (demo)", monthlyAmount: 300000, active: true }
];

export function useProfitability() {
  const { profile } = useAuth();
  const branchId = isSupabaseConfigured ? profile?.branch_id ?? null : DEMO_BRANCH_ID;

  const [fixedCosts, setFixedCosts] = useState<FixedCost[]>(isSupabaseConfigured ? [] : DEMO_FIXED_COSTS);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const [purchasedProducts, setPurchasedProducts] = useState<PurchasedProductRanking[]>([]);
  const [purchasedProductsLoading, setPurchasedProductsLoading] = useState(false);

  const [periods, setPeriods] = useState<ProfitabilityPeriod[]>([]);

  const [stockCounts, setStockCounts] = useState<StockCount[]>([]);
  const [stockCountsLoading, setStockCountsLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    setError(null);
    try {
      setFixedCosts(await listFixedCosts());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los costos fijos.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const reloadPeriods = useCallback(async () => {
    if (!isSupabaseConfigured || !branchId) return;
    setPeriods(await listProfitabilityPeriods(branchId));
  }, [branchId]);

  useEffect(() => {
    void reloadPeriods();
  }, [reloadPeriods]);

  const addFixedCost = useCallback(
    async (input: Omit<CreateFixedCostInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const fixedCost: FixedCost = { id: crypto.randomUUID(), branchId, name: input.name, monthlyAmount: input.monthlyAmount, active: true };
        setFixedCosts((current) => [...current, fixedCost]);
        return fixedCost;
      }

      const result = await createFixedCost({ ...input, branchId });
      await reload();
      return result;
    },
    [branchId, reload]
  );

  const editFixedCost = useCallback(
    async (input: UpdateFixedCostInput) => {
      if (!isSupabaseConfigured) {
        setFixedCosts((current) =>
          current.map((f) => (f.id === input.id ? { ...f, name: input.name, monthlyAmount: input.monthlyAmount, active: input.active } : f))
        );
        return;
      }

      await updateFixedCost(input);
      await reload();
    },
    [reload]
  );

  const loadPurchasedProducts = useCallback(
    async (fromDate: string, toDate: string) => {
      if (!isSupabaseConfigured || !branchId) return;
      setPurchasedProductsLoading(true);
      try {
        setPurchasedProducts(await listPurchasedProductsInRange(branchId, fromDate, toDate));
      } finally {
        setPurchasedProductsLoading(false);
      }
    },
    [branchId]
  );

  const getPurchasesTotal = useCallback(
    async (fromDate: string, toDate: string) => {
      if (!branchId) return 0;
      return getPurchasesTotalInRange(branchId, fromDate, toDate);
    },
    [branchId]
  );

  const closePeriod = useCallback(
    async (input: Omit<ClosePeriodInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");
      if (!isSupabaseConfigured) throw new Error("Configurá Supabase para cerrar períodos.");

      const result = await closeProfitabilityPeriod({ ...input, branchId });
      await reloadPeriods();
      return result;
    },
    [branchId, reloadPeriods]
  );

  const loadStockCounts = useCallback(
    async (fromDate: string, toDate: string) => {
      if (!isSupabaseConfigured || !branchId) return;
      setStockCountsLoading(true);
      try {
        setStockCounts(await listStockCounts(branchId, fromDate, toDate));
      } finally {
        setStockCountsLoading(false);
      }
    },
    [branchId]
  );

  const addStockCount = useCallback(
    async (input: Omit<SaveStockCountInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");
      if (!isSupabaseConfigured) return;
      await saveStockCount({ ...input, branchId });
    },
    [branchId]
  );

  const removeStockCount = useCallback(async (stockCountId: string) => {
    if (!isSupabaseConfigured) return;
    await deleteStockCount(stockCountId);
  }, []);

  const getStockNear = useCallback(
    async (date: string) => {
      if (!branchId) return null;
      return getStockTotalNearDate(branchId, date);
    },
    [branchId]
  );

  return {
    branchId,
    fixedCosts,
    loading,
    error,
    addFixedCost,
    editFixedCost,
    purchasedProducts,
    purchasedProductsLoading,
    loadPurchasedProducts,
    getPurchasesTotal,
    periods,
    closePeriod,
    stockCounts,
    stockCountsLoading,
    loadStockCounts,
    addStockCount,
    removeStockCount,
    getStockNear
  };
}
