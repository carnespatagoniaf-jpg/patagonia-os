import { useCallback, useEffect, useState } from "react";
import type { TreasuryAccount } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import {
  adjustTreasuryAccount,
  createTreasuryAccount,
  listTreasuryAccounts,
  listTreasuryBalances,
  listTreasuryMovements,
  transferTreasuryFunds,
  type AdjustTreasuryAccountInput,
  type CreateTreasuryAccountInput,
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
      const [accountList, balanceList, movementList] = await Promise.all([
        listTreasuryAccounts(),
        listTreasuryBalances(),
        listTreasuryMovements()
      ]);
      setAccounts(accountList);
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

  return { accounts, balances, movements, loading, error, create, adjust, transfer, reload };
}
