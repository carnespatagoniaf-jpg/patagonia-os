import { useCallback, useEffect, useState } from "react";
import type { Creditor, CreditorBalance, CreditorDebt, CreditorPayment } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import {
  createCreditor,
  createCreditorDebt,
  deleteCreditorDebt,
  deleteCreditorPayment,
  getCreditorBalance,
  listCreditorDebts,
  listCreditorPayments,
  listCreditors,
  registerCreditorPayment,
  updateCreditorDebt,
  updateCreditorPayment,
  type CreateCreditorDebtInput,
  type CreateCreditorInput,
  type RegisterCreditorPaymentInput,
  type UpdateCreditorDebtInput,
  type UpdateCreditorPaymentInput
} from "./creditors-service";

export function useCreditors() {
  const { branchId } = useActiveBranch();

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

  const editDebt = useCallback(
    async (creditorId: string, input: UpdateCreditorDebtInput) => {
      await updateCreditorDebt(input);
      await loadDetail(creditorId);
    },
    [loadDetail]
  );

  const removeDebt = useCallback(
    async (creditorId: string, debtId: string) => {
      await deleteCreditorDebt(debtId);
      await loadDetail(creditorId);
    },
    [loadDetail]
  );

  const editPayment = useCallback(
    async (creditorId: string, input: UpdateCreditorPaymentInput) => {
      await updateCreditorPayment(input);
      await loadDetail(creditorId);
    },
    [loadDetail]
  );

  const removePayment = useCallback(
    async (creditorId: string, paymentId: string) => {
      await deleteCreditorPayment(paymentId);
      await loadDetail(creditorId);
    },
    [loadDetail]
  );

  return {
    branchId,
    creditors,
    loading,
    error,
    create,
    debts,
    payments,
    balance,
    detailLoading,
    loadDetail,
    addDebt,
    registerPayment,
    editDebt,
    removeDebt,
    editPayment,
    removePayment
  };
}
