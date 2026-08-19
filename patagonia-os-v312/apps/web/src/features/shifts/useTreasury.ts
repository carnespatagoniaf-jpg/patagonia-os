import { useCallback, useEffect, useState } from "react";
import type { TreasuryAccount } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import {
  adjustTreasuryAccount,
  createTreasuryAccount,
  deleteTreasuryExpense,
  listAllTreasuryAccounts,
  listTreasuryAccounts,
  listTreasuryBalances,
  listTreasuryMovements,
  registerTreasuryExpense,
  setTreasuryAccountActive,
  transferTreasuryFunds,
  type AdjustTreasuryAccountInput,
  type CreateTreasuryAccountInput,
  type RegisterTreasuryExpenseInput,
  type TransferTreasuryFundsInput,
  type TreasuryAccountBalance,
  type TreasuryMovementRow
} from "./treasury-service";

const DEMO_ACCOUNTS: TreasuryAccount[] = [
  { id: "demo-cash", name: "Efectivo", paymentMethod: "cash", initialBalance: 50000, active: true },
  { id: "demo-qr", name: "Mercado Pago", paymentMethod: "qr", initialBalance: 20000, active: true },
  { id: "demo-bank", name: "Banco Provincia", paymentMethod: "bank_province", initialBalance: 10000, active: true }
];

export function useTreasury() {
  const { branchId } = useActiveBranch();

  const [accounts, setAccounts] = useState<TreasuryAccount[]>(isSupabaseConfigured ? [] : DEMO_ACCOUNTS);
  const [allAccounts, setAllAccounts] = useState<TreasuryAccount[]>(isSupabaseConfigured ? [] : DEMO_ACCOUNTS);
  const [balances, setBalances] = useState<TreasuryAccountBalance[]>(
    isSupabaseConfigured
      ? []
      : DEMO_ACCOUNTS.map((a) => ({ accountId: a.id, name: a.name, initialBalance: a.initialBalance, balance: a.initialBalance }))
  );
  const [movements, setMovements] = useState<TreasuryMovementRow[]>([]);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;

    setLoading(true);
    setError(null);
    try {
      const [accountList, allAccountList, balanceList, movementList] = await Promise.all([
        listTreasuryAccounts(),
        listAllTreasuryAccounts(),
        listTreasuryBalances(),
        listTreasuryMovements()
      ]);
      setAccounts(accountList);
      setAllAccounts(allAccountList);
      setBalances(balanceList);
      setMovements(movementList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las cuentas de tesorería.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (input: CreateTreasuryAccountInput) => {
      if (!isSupabaseConfigured) {
        const account: TreasuryAccount = { id: crypto.randomUUID(), active: true, ...input };
        setAccounts((current) => [...current, account]);
        setAllAccounts((current) => [...current, account]);
        setBalances((current) => [
          ...current,
          { accountId: account.id, name: account.name, initialBalance: account.initialBalance, balance: account.initialBalance }
        ]);
        return account;
      }

      const account = await createTreasuryAccount(input);
      await reload();
      return account;
    },
    [reload]
  );

  const adjust = useCallback(
    async (input: Omit<AdjustTreasuryAccountInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const delta = input.direction === "in" ? input.amount : -input.amount;
        setBalances((current) =>
          current.map((b) => (b.accountId === input.accountId ? { ...b, balance: b.balance + delta } : b))
        );
        const account = accounts.find((a) => a.id === input.accountId);
        setMovements((current) => [
          {
            id: crypto.randomUUID(),
            accountName: account?.name ?? "-",
            direction: input.direction,
            amount: input.amount,
            movementType: "ajuste",
            category: null,
            occurredOn: new Date().toISOString().slice(0, 10),
            notes: input.reason
          },
          ...current
        ]);
        return;
      }

      await adjustTreasuryAccount({ ...input, branchId });
      await reload();
    },
    [branchId, accounts, reload]
  );

  const registerExpense = useCallback(
    async (input: Omit<RegisterTreasuryExpenseInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        setBalances((current) =>
          current.map((b) => (b.accountId === input.accountId ? { ...b, balance: b.balance - input.amount } : b))
        );
        const account = accounts.find((a) => a.id === input.accountId);
        setMovements((current) => [
          {
            id: crypto.randomUUID(),
            accountName: account?.name ?? "-",
            direction: "out",
            amount: input.amount,
            movementType: "gasto",
            category: input.category,
            occurredOn: input.expenseDate,
            notes: input.description
          },
          ...current
        ]);
        return;
      }

      await registerTreasuryExpense({ ...input, branchId });
      await reload();
    },
    [branchId, accounts, reload]
  );

  const removeExpense = useCallback(
    async (movementId: string) => {
      if (!isSupabaseConfigured) {
        setMovements((current) => current.filter((m) => m.id !== movementId));
        return;
      }

      await deleteTreasuryExpense(movementId);
      await reload();
    },
    [reload]
  );

  const transfer = useCallback(
    async (input: Omit<TransferTreasuryFundsInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");
      if (input.fromAccountId === input.toAccountId) throw new Error("Elegí dos cuentas distintas.");

      if (!isSupabaseConfigured) {
        setBalances((current) =>
          current.map((b) => {
            if (b.accountId === input.fromAccountId) return { ...b, balance: b.balance - input.amount };
            if (b.accountId === input.toAccountId) return { ...b, balance: b.balance + input.amount };
            return b;
          })
        );
        return;
      }

      await transferTreasuryFunds({ ...input, branchId });
      await reload();
    },
    [branchId, reload]
  );

  const setActive = useCallback(
    async (accountId: string, active: boolean) => {
      if (!isSupabaseConfigured) {
        setAccounts((current) =>
          active ? current : current.filter((a) => a.id !== accountId)
        );
        setAllAccounts((current) => current.map((a) => (a.id === accountId ? { ...a, active } : a)));
        return;
      }

      await setTreasuryAccountActive(accountId, active);
      await reload();
    },
    [reload]
  );

  return { accounts, allAccounts, balances, movements, loading, error, create, adjust, transfer, registerExpense, removeExpense, setActive, reload };
}
