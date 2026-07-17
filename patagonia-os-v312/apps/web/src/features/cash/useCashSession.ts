import { useCallback, useEffect, useRef, useState } from "react";
import type { CashSession } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { closeCashSession, fetchOpenCashSession, openCashSession } from "./cash-service";

const DEMO_BRANCH_ID = "demo-branch";

export interface CashSessionCloseSummary {
  closingCounted: number;
  expectedCash: number;
  difference: number;
}

export function useCashSession() {
  const { profile } = useAuth();
  const [session, setSession] = useState<CashSession | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);
  const [lastClose, setLastClose] = useState<CashSessionCloseSummary | null>(null);
  const demoCashIn = useRef(0);

  const branchId = isSupabaseConfigured ? profile?.branch_id ?? null : DEMO_BRANCH_ID;

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    if (!branchId) {
      setSession(null);
      setError("Tu usuario no tiene sucursal asignada.");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchOpenCashSession(branchId)
      .then((result) => {
        if (!cancelled) setSession(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudo verificar la caja.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [branchId]);

  const open = useCallback(
    async (openingAmount: number) => {
      if (!branchId) {
        setError("Tu usuario no tiene sucursal asignada.");
        return;
      }

      setError(null);
      demoCashIn.current = 0;
      setLastClose(null);

      if (!isSupabaseConfigured) {
        setSession({
          id: crypto.randomUUID(),
          branchId,
          status: "open",
          openingAmount,
          openedAt: new Date().toISOString(),
          openedBy: "demo"
        });
        return;
      }

      const result = await openCashSession({ branchId, openingAmount });
      setSession(result);
    },
    [branchId]
  );

  const close = useCallback(
    async (closingCounted: number) => {
      if (!branchId) {
        setError("Tu usuario no tiene sucursal asignada.");
        return;
      }

      setError(null);

      if (!isSupabaseConfigured) {
        if (!session) {
          setError("No hay una caja abierta para esta sucursal.");
          return;
        }

        const expectedCash = session.openingAmount + demoCashIn.current;
        const difference = closingCounted - expectedCash;
        const closedAt = new Date().toISOString();

        setSession({ ...session, status: "closed", closingCounted, difference, closedAt });
        setLastClose({ closingCounted, expectedCash, difference });
        return;
      }

      const result = await closeCashSession({ branchId, closingCounted });
      setSession(result);
      setLastClose({
        closingCounted: result.closingCounted ?? closingCounted,
        expectedCash: result.expectedCash,
        difference: result.difference ?? 0
      });
    },
    [branchId, session]
  );

  const registerCashSale = useCallback((amount: number) => {
    if (isSupabaseConfigured) return;
    demoCashIn.current += amount;
  }, []);

  return { session, loading, error, lastClose, open, close, registerCashSale };
}
