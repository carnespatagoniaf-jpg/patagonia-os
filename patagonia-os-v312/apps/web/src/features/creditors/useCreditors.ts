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
  listCreditorsWithBalance,
  registerCreditorPayment,
  updateCreditor,
  updateCreditorDebt,
  updateCreditorPayment,
  type CreateCreditorDebtInput,
  type CreateCreditorInput,
  type RegisterCreditorPaymentInput,
  type UpdateCreditorDebtInput,
  type UpdateCreditorInput,
  type UpdateCreditorPaymentInput
} from "./creditors-service";

export type CreditorWithBalance = Creditor & { balance: number; lastActivityDate?: string };

interface DemoLedger {
  debts: CreditorDebt[];
  payments: CreditorPayment[];
}

function computeDemoBalance(creditorId: string, ledger: DemoLedger | undefined): CreditorBalance {
  const totalDebt = ledger?.debts.reduce((sum, d) => sum + d.amount, 0) ?? 0;
  const totalPaid = ledger?.payments.reduce((sum, p) => sum + p.amount, 0) ?? 0;
  return { creditorId, totalDebt, totalPaid, balance: totalDebt - totalPaid };
}

export function useCreditors() {
  const { branchId } = useActiveBranch();

  const [creditors, setCreditors] = useState<CreditorWithBalance[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const [debts, setDebts] = useState<CreditorDebt[]>([]);
  const [payments, setPayments] = useState<CreditorPayment[]>([]);
  const [balance, setBalance] = useState<CreditorBalance | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [demoLedgers, setDemoLedgers] = useState<Record<string, DemoLedger>>({});

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    setError(null);
    try {
      setCreditors(await listCreditorsWithBalance());
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

      if (!isSupabaseConfigured) {
        const creditor: CreditorWithBalance = { id: crypto.randomUUID(), branchId, active: true, balance: 0, ...input };
        setCreditors((current) => [...current, creditor]);
        return creditor;
      }

      const result = await createCreditor({ ...input, branchId });
      await reload();
      return result;
    },
    [branchId, reload]
  );

  const update = useCallback(
    async (input: UpdateCreditorInput) => {
      if (!isSupabaseConfigured) {
        setCreditors((current) =>
          current
            .map((c) => (c.id === input.id ? { ...c, ...input } : c))
            .filter((c) => c.id !== input.id || input.active)
        );
        return;
      }

      await updateCreditor(input);
      await reload();
    },
    [reload]
  );

  const loadDetail = useCallback(
    async (creditorId: string) => {
      if (!isSupabaseConfigured) {
        const ledger = demoLedgers[creditorId];
        setDebts(ledger?.debts ?? []);
        setPayments(ledger?.payments ?? []);
        setBalance(computeDemoBalance(creditorId, ledger));
        return;
      }

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
    },
    [demoLedgers]
  );

  const applyDemoLedger = useCallback((creditorId: string, next: DemoLedger) => {
    setDemoLedgers((current) => ({ ...current, [creditorId]: next }));
    setDebts(next.debts);
    setPayments(next.payments);
    setBalance(computeDemoBalance(creditorId, next));
  }, []);

  const addDebt = useCallback(
    async (input: CreateCreditorDebtInput) => {
      if (!isSupabaseConfigured) {
        const debt: CreditorDebt = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...input };
        const existing = demoLedgers[input.creditorId] ?? { debts: [], payments: [] };
        applyDemoLedger(input.creditorId, { ...existing, debts: [debt, ...existing.debts] });
        return;
      }

      await createCreditorDebt(input);
      await loadDetail(input.creditorId);
    },
    [loadDetail, demoLedgers, applyDemoLedger]
  );

  const registerPayment = useCallback(
    async (input: Omit<RegisterCreditorPaymentInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const payment: CreditorPayment = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...input };
        const existing = demoLedgers[input.creditorId] ?? { debts: [], payments: [] };
        const next = { ...existing, payments: [payment, ...existing.payments] };
        applyDemoLedger(input.creditorId, next);
        return { id: payment.id, balance: computeDemoBalance(input.creditorId, next).balance };
      }

      const result = await registerCreditorPayment({ ...input, branchId });
      await loadDetail(input.creditorId);
      return result;
    },
    [branchId, loadDetail, demoLedgers, applyDemoLedger]
  );

  const editDebt = useCallback(
    async (creditorId: string, input: UpdateCreditorDebtInput) => {
      if (!isSupabaseConfigured) {
        const ledger = demoLedgers[creditorId];
        if (ledger) {
          const debts = ledger.debts.map((d) => (d.id === input.id ? { ...d, ...input } : d));
          applyDemoLedger(creditorId, { ...ledger, debts });
        }
        return;
      }

      await updateCreditorDebt(input);
      await loadDetail(creditorId);
    },
    [loadDetail, demoLedgers, applyDemoLedger]
  );

  const removeDebt = useCallback(
    async (creditorId: string, debtId: string) => {
      if (!isSupabaseConfigured) {
        const ledger = demoLedgers[creditorId];
        if (ledger) applyDemoLedger(creditorId, { ...ledger, debts: ledger.debts.filter((d) => d.id !== debtId) });
        return;
      }

      await deleteCreditorDebt(debtId);
      await loadDetail(creditorId);
    },
    [loadDetail, demoLedgers, applyDemoLedger]
  );

  const editPayment = useCallback(
    async (creditorId: string, input: UpdateCreditorPaymentInput) => {
      if (!isSupabaseConfigured) {
        const ledger = demoLedgers[creditorId];
        if (ledger) {
          const payments = ledger.payments.map((p) => (p.id === input.id ? { ...p, ...input } : p));
          applyDemoLedger(creditorId, { ...ledger, payments });
        }
        return;
      }

      await updateCreditorPayment(input);
      await loadDetail(creditorId);
    },
    [loadDetail, demoLedgers, applyDemoLedger]
  );

  const removePayment = useCallback(
    async (creditorId: string, paymentId: string) => {
      if (!isSupabaseConfigured) {
        const ledger = demoLedgers[creditorId];
        if (ledger) applyDemoLedger(creditorId, { ...ledger, payments: ledger.payments.filter((p) => p.id !== paymentId) });
        return;
      }

      await deleteCreditorPayment(paymentId);
      await loadDetail(creditorId);
    },
    [loadDetail, demoLedgers, applyDemoLedger]
  );

  return {
    branchId,
    creditors,
    loading,
    error,
    create,
    update,
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
