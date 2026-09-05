import { useCallback, useEffect, useState } from "react";
import type { Customer, CustomerBalance, CustomerCharge, CustomerPayment } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import {
  createCustomer,
  createCustomerCharge,
  createCustomerChargeWithItems,
  deleteCustomerCharge,
  deleteCustomerPayment,
  getCustomerBalance,
  getCustomerChargeItems,
  listCustomerCharges,
  listCustomerPayments,
  listCustomersWithBalance,
  registerCustomerPayment,
  updateCustomer,
  updateCustomerCharge,
  updateCustomerPayment,
  type CreateCustomerChargeInput,
  type CreateCustomerChargeWithItemsInput,
  type CreateCustomerInput,
  type CustomerChargeItem,
  type RegisterCustomerPaymentInput,
  type UpdateCustomerChargeInput,
  type UpdateCustomerInput,
  type UpdateCustomerPaymentInput
} from "./customers-service";

export type CustomerWithBalance = Customer & { balance: number; lastActivityDate?: string };

interface DemoLedger {
  charges: CustomerCharge[];
  payments: CustomerPayment[];
}

function computeDemoBalance(customerId: string, ledger: DemoLedger | undefined): CustomerBalance {
  const totalCharged = ledger?.charges.reduce((sum, c) => sum + c.amount, 0) ?? 0;
  const totalPaid = ledger?.payments.reduce((sum, p) => sum + p.amount, 0) ?? 0;
  return { customerId, totalCharged, totalPaid, balance: totalCharged - totalPaid };
}

export function useCustomers() {
  const { branchId } = useActiveBranch();

  const [customers, setCustomers] = useState<CustomerWithBalance[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const [charges, setCharges] = useState<CustomerCharge[]>([]);
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [balance, setBalance] = useState<CustomerBalance | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [demoLedgers, setDemoLedgers] = useState<Record<string, DemoLedger>>({});

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    setError(null);
    try {
      setCustomers(await listCustomersWithBalance());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los clientes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (input: Omit<CreateCustomerInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const customer: CustomerWithBalance = { id: crypto.randomUUID(), branchId, active: true, balance: 0, ...input };
        setCustomers((current) => [...current, customer]);
        return customer;
      }

      const result = await createCustomer({ ...input, branchId });
      await reload();
      return result;
    },
    [branchId, reload]
  );

  const update = useCallback(
    async (input: UpdateCustomerInput) => {
      if (!isSupabaseConfigured) {
        setCustomers((current) =>
          current
            .map((c) => (c.id === input.id ? { ...c, ...input } : c))
            .filter((c) => c.id !== input.id || input.active)
        );
        return;
      }

      await updateCustomer(input);
      await reload();
    },
    [reload]
  );

  const loadDetail = useCallback(
    async (customerId: string) => {
      if (!isSupabaseConfigured) {
        const ledger = demoLedgers[customerId];
        setCharges(ledger?.charges ?? []);
        setPayments(ledger?.payments ?? []);
        setBalance(computeDemoBalance(customerId, ledger));
        return;
      }

      setDetailLoading(true);
      try {
        const [chargeList, paymentList, balanceRow] = await Promise.all([
          listCustomerCharges(customerId),
          listCustomerPayments(customerId),
          getCustomerBalance(customerId)
        ]);
        setCharges(chargeList);
        setPayments(paymentList);
        setBalance(balanceRow);
      } finally {
        setDetailLoading(false);
      }
    },
    [demoLedgers]
  );

  const applyDemoLedger = useCallback((customerId: string, next: DemoLedger) => {
    setDemoLedgers((current) => ({ ...current, [customerId]: next }));
    setCharges(next.charges);
    setPayments(next.payments);
    setBalance(computeDemoBalance(customerId, next));
  }, []);

  const addCharge = useCallback(
    async (input: CreateCustomerChargeInput) => {
      if (!isSupabaseConfigured) {
        const charge: CustomerCharge = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...input };
        const existing = demoLedgers[input.customerId] ?? { charges: [], payments: [] };
        applyDemoLedger(input.customerId, { ...existing, charges: [charge, ...existing.charges] });
        return;
      }

      await createCustomerCharge(input);
      await loadDetail(input.customerId);
    },
    [loadDetail, demoLedgers, applyDemoLedger]
  );

  const addChargeWithItems = useCallback(
    async (input: Omit<CreateCustomerChargeWithItemsInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const total = input.items.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.quantity, 0);
        const charge: CustomerCharge = {
          id: crypto.randomUUID(),
          customerId: input.customerId,
          chargeDate: input.chargeDate,
          amount: Math.round(total),
          reason: input.reason?.trim() || "Entrega (modo demo)",
          createdAt: new Date().toISOString()
        };
        const existing = demoLedgers[input.customerId] ?? { charges: [], payments: [] };
        applyDemoLedger(input.customerId, { ...existing, charges: [charge, ...existing.charges] });
        return { id: charge.id, amount: charge.amount };
      }

      const result = await createCustomerChargeWithItems({ ...input, branchId });
      await loadDetail(input.customerId);
      return result;
    },
    [branchId, loadDetail, demoLedgers, applyDemoLedger]
  );

  const loadChargeItems = useCallback(async (chargeId: string): Promise<CustomerChargeItem[]> => {
    if (!isSupabaseConfigured) return [];
    return getCustomerChargeItems(chargeId);
  }, []);

  const registerPayment = useCallback(
    async (input: Omit<RegisterCustomerPaymentInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const payment: CustomerPayment = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...input };
        const existing = demoLedgers[input.customerId] ?? { charges: [], payments: [] };
        const next = { ...existing, payments: [payment, ...existing.payments] };
        applyDemoLedger(input.customerId, next);
        return { id: payment.id, balance: computeDemoBalance(input.customerId, next).balance };
      }

      const result = await registerCustomerPayment({ ...input, branchId });
      await loadDetail(input.customerId);
      return result;
    },
    [branchId, loadDetail, demoLedgers, applyDemoLedger]
  );

  const editCharge = useCallback(
    async (customerId: string, input: UpdateCustomerChargeInput) => {
      if (!isSupabaseConfigured) {
        const ledger = demoLedgers[customerId];
        if (ledger) {
          const charges = ledger.charges.map((c) => (c.id === input.id ? { ...c, ...input } : c));
          applyDemoLedger(customerId, { ...ledger, charges });
        }
        return;
      }

      await updateCustomerCharge(input);
      await loadDetail(customerId);
    },
    [loadDetail, demoLedgers, applyDemoLedger]
  );

  const removeCharge = useCallback(
    async (customerId: string, chargeId: string) => {
      if (!isSupabaseConfigured) {
        const ledger = demoLedgers[customerId];
        if (ledger) applyDemoLedger(customerId, { ...ledger, charges: ledger.charges.filter((c) => c.id !== chargeId) });
        return;
      }

      await deleteCustomerCharge(chargeId);
      await loadDetail(customerId);
    },
    [loadDetail, demoLedgers, applyDemoLedger]
  );

  const editPayment = useCallback(
    async (customerId: string, input: UpdateCustomerPaymentInput) => {
      if (!isSupabaseConfigured) {
        const ledger = demoLedgers[customerId];
        if (ledger) {
          const payments = ledger.payments.map((p) => (p.id === input.id ? { ...p, ...input } : p));
          applyDemoLedger(customerId, { ...ledger, payments });
        }
        return;
      }

      await updateCustomerPayment(input);
      await loadDetail(customerId);
    },
    [loadDetail, demoLedgers, applyDemoLedger]
  );

  const removePayment = useCallback(
    async (customerId: string, paymentId: string) => {
      if (!isSupabaseConfigured) {
        const ledger = demoLedgers[customerId];
        if (ledger) applyDemoLedger(customerId, { ...ledger, payments: ledger.payments.filter((p) => p.id !== paymentId) });
        return;
      }

      await deleteCustomerPayment(paymentId);
      await loadDetail(customerId);
    },
    [loadDetail, demoLedgers, applyDemoLedger]
  );

  return {
    branchId,
    customers,
    loading,
    error,
    create,
    update,
    charges,
    payments,
    balance,
    detailLoading,
    loadDetail,
    addCharge,
    addChargeWithItems,
    loadChargeItems,
    registerPayment,
    editCharge,
    removeCharge,
    editPayment,
    removePayment
  };
}
