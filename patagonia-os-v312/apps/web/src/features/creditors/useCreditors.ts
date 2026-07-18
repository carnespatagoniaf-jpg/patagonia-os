import { useCallback, useEffect, useState } from "react";
import type { Creditor, CreditorBalance, CreditorDebt, CreditorPayment } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import {
  createCreditor,
  createCreditorDebt,
  getCreditorBalance,
  listCreditorDebts,
  listCreditorPayments,
  listCreditors,
  registerCreditorPayment,
  type CreateCreditorDebtInput,
  type CreateCreditorInput,
  type RegisterCreditorPaymentInput
} from "./creditors-service";

const DEMO_BRANCH_ID = "demo-branch";

export function useCreditors() {
  const { profile } = useAuth();
  const branchId = isSupabaseConfigured ? profile?.branch_id ?? null : DEMO_BRANCH_ID;

  const [creditors, setCreditors] = useState<Creditor[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const [debts, setDebts] = useState<CreditorDebt[]>([]);
  const [payments, setPayments] = useState<CreditorPayment[]>([]);
  const [balance, setBalance] = useState<CreditorBalance | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    setError(null);
    try {
      setCreditors(await listCreditors());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los acreedores.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (input: Omit<CreateCreditorInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");
      const result = await createCreditor({ ...input, branchId });
      await reload();
      return result;
    },
    [branchId, reload]
  );

  const loadDetail = useCallback(async (creditorId: string) => {
    setDetailLoading(true);
    try {
      const [debtList, paymentList, balanceRow] = await Promise.all([
        listCreditorDebts(creditorId),
        listCreditorPayments(creditorId),
        getCreditorBalance(creditorId)
      ]);
      setDebts(debtList);
      setPayments(paymentList);
      setBalance(balanceRow);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const addDebt = useCallback(
    async (input: CreateCreditorDebtInput) => {
      await createCreditorDebt(input);
      await loadDetail(input.creditorId);
    },
    [loadDetail]
  );

  const registerPayment = useCallback(
    async (input: Omit<RegisterCreditorPaymentInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");
      const result = await registerCreditorPayment({ ...input, branchId });
      await loadDetail(input.creditorId);
      return result;
    },
    [branchId, loadDetail]
  );

  return { branchId, creditors, loading, error, create, debts, payments, balance, detailLoading, loadDetail, addDebt, registerPayment };
}
