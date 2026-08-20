import { useCallback, useEffect, useState } from "react";
import type { Customer, CustomerBalance, CustomerCharge, CustomerPayment } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import {
  createCustomer,
  createCustomerCharge,
  deleteCustomerCharge,
  deleteCustomerPayment,
  getCustomerBalance,
  listCustomerCharges,
  listCustomerPayments,
  listCustomers,
  registerCustomerPayment,
  updateCustomerCharge,
  updateCustomerPayment,
  type CreateCustomerChargeInput,
  type CreateCustomerInput,
  type RegisterCustomerPaymentInput,
  type UpdateCustomerChargeInput,
  type UpdateCustomerPaymentInput
} from "./customers-service";

export function useCustomers() {
  const { branchId } = useActiveBranch();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const [charges, setCharges] = useState<CustomerCharge[]>([]);
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [balance, setBalance] = useState<CustomerBalance | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    setError(null);
    try {
      setCustomers(await listCustomers());
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
      const result = await createCustomer({ ...input, branchId });
      await reload();
      return result;
    },
    [branchId, reload]
  );

  const loadDetail = useCallback(async (customerId: string) => {
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
  }, []);

  const addCharge = useCallback(
    async (input: CreateCustomerChargeInput) => {
      await createCustomerCharge(input);
      await loadDetail(input.customerId);
    },
    [loadDetail]
  );

  const registerPayment = useCallback(
    async (input: Omit<RegisterCustomerPaymentInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");
      const result = await registerCustomerPayment({ ...input, branchId });
      await loadDetail(input.customerId);
      return result;
    },
    [branchId, loadDetail]
  );

  const editCharge = useCallback(
    async (customerId: string, input: UpdateCustomerChargeInput) => {
      await updateCustomerCharge(input);
      await loadDetail(customerId);
    },
    [loadDetail]
  );

  const removeCharge = useCallback(
    async (customerId: string, chargeId: string) => {
      await deleteCustomerCharge(chargeId);
      await loadDetail(customerId);
    },
    [loadDetail]
  );

  const editPayment = useCallback(
    async (customerId: string, input: UpdateCustomerPaymentInput) => {
      await updateCustomerPayment(input);
      await loadDetail(customerId);
    },
    [loadDetail]
  );

  const removePayment = useCallback(
    async (customerId: string, paymentId: string) => {
      await deleteCustomerPayment(paymentId);
      await loadDetail(customerId);
    },
    [loadDetail]
  );

  return {
    branchId,
    customers,
    loading,
    error,
    create,
    charges,
    payments,
    balance,
    detailLoading,
    loadDetail,
    addCharge,
    registerPayment,
    editCharge,
    removeCharge,
    editPayment,
    removePayment
  };
}
