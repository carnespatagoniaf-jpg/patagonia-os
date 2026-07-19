import { useCallback, useState } from "react";
import type { Purchase, PurchaseItem, SupplierPayment } from "@patagonia/domain";
import { purchaseTotal } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import {
  createPurchase,
  listPurchaseItems,
  listPurchasesForSupplier,
  listSupplierPayments,
  registerSupplierPayment,
  updatePurchaseItem,
  type CreatePurchaseInput,
  type PurchaseLineInput,
  type RegisterSupplierPaymentInput
} from "./purchases-service";
import { fetchSupplierBalance, type SupplierBalance } from "./suppliers-service";

interface DemoLedger {
  purchases: Purchase[];
  items: Record<string, PurchaseItem[]>;
  payments: SupplierPayment[];
}

export function usePurchases() {
  const { branchId } = useActiveBranch();

  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [items, setItems] = useState<Record<string, PurchaseItem[]>>({});
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [balance, setBalance] = useState<SupplierBalance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoLedgers, setDemoLedgers] = useState<Record<string, DemoLedger>>({});

  const computeDemoBalance = (ledger: DemoLedger | undefined): SupplierBalance | null => {
    if (!ledger) return null;
    const totalPurchases = ledger.purchases.reduce((sum, p) => sum + p.total, 0);
    const totalPayments = ledger.payments.reduce((sum, p) => sum + p.amount, 0);
    return {
      supplierId: "",
      totalPurchases,
      totalPayments,
      balance: totalPurchases - totalPayments
    };
  };

  const loadSupplier = useCallback(
    async (supplierId: string) => {
      if (!isSupabaseConfigured) {
        const ledger = demoLedgers[supplierId];
        setPurchases(ledger?.purchases ?? []);
        setItems(ledger?.items ?? {});
        setPayments(ledger?.payments ?? []);
        setBalance(computeDemoBalance(ledger));
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const [purchaseList, paymentList, supplierBalance] = await Promise.all([
          listPurchasesForSupplier(supplierId),
          listSupplierPayments(supplierId),
          fetchSupplierBalance(supplierId)
        ]);
        setPurchases(purchaseList);
        setPayments(paymentList);
        setBalance(supplierBalance);

        const itemLists = await Promise.all(purchaseList.map((p) => listPurchaseItems(p.id)));
        const itemsByPurchase: Record<string, PurchaseItem[]> = {};
        purchaseList.forEach((p, index) => {
          itemsByPurchase[p.id] = itemLists[index];
        });
        setItems(itemsByPurchase);
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo cargar la cuenta corriente.");
      } finally {
        setLoading(false);
      }
    },
    [demoLedgers]
  );

  const create = useCallback(
    async (
      supplierId: string,
      purchaseDate: string,
      invoiceNumber: string | undefined,
      lines: PurchaseLineInput[]
    ) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const purchaseId = crypto.randomUUID();
        const total = purchaseTotal(lines);
        const purchase: Purchase = {
          id: purchaseId,
          branchId,
          supplierId,
          purchaseDate,
          invoiceNumber,
          total,
          createdBy: "demo",
          createdAt: new Date().toISOString()
        };
        const purchaseItems: PurchaseItem[] = lines.map((line) => ({
          id: crypto.randomUUID(),
          purchaseId,
          productId: line.productId,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          lineTotal: line.quantity * line.unitPrice
        }));

        setDemoLedgers((current) => {
          const existing = current[supplierId] ?? { purchases: [], items: {}, payments: [] };
          const next: DemoLedger = {
            purchases: [purchase, ...existing.purchases],
            items: { ...existing.items, [purchaseId]: purchaseItems },
            payments: existing.payments
          };
          return { ...current, [supplierId]: next };
        });

        await loadSupplier(supplierId);
        return { id: purchaseId, total };
      }

      const input: CreatePurchaseInput = { branchId, supplierId, purchaseDate, invoiceNumber, items: lines };
      const result = await createPurchase(input);
      await loadSupplier(supplierId);
      return result;
    },
    [branchId, loadSupplier]
  );

  const editItem = useCallback(
    async (supplierId: string, itemId: string, quantity: number, unitPrice: number) => {
      if (!isSupabaseConfigured) {
        setDemoLedgers((current) => {
          const ledger = current[supplierId];
          if (!ledger) return current;
          const nextItems: Record<string, PurchaseItem[]> = {};
          let purchaseId = "";
          for (const [pid, list] of Object.entries(ledger.items)) {
            nextItems[pid] = list.map((item) => {
              if (item.id !== itemId) return item;
              purchaseId = pid;
              return { ...item, quantity, unitPrice, lineTotal: quantity * unitPrice };
            });
          }
          const nextPurchases = ledger.purchases.map((p) =>
            p.id === purchaseId
              ? { ...p, total: (nextItems[purchaseId] ?? []).reduce((sum, i) => sum + i.lineTotal, 0) }
              : p
          );
          return { ...current, [supplierId]: { ...ledger, purchases: nextPurchases, items: nextItems } };
        });
        await loadSupplier(supplierId);
        return;
      }

      await updatePurchaseItem(itemId, quantity, unitPrice);
      await loadSupplier(supplierId);
    },
    [loadSupplier]
  );

  const registerPayment = useCallback(
    async (input: Omit<RegisterSupplierPaymentInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const payment: SupplierPayment = {
          id: crypto.randomUUID(),
          branchId,
          supplierId: input.supplierId,
          paymentDate: input.paymentDate,
          amount: input.amount,
          paymentMethod: input.paymentMethod,
          notes: input.notes,
          createdAt: new Date().toISOString()
        };
        setDemoLedgers((current) => {
          const existing = current[input.supplierId] ?? { purchases: [], items: {}, payments: [] };
          return {
            ...current,
            [input.supplierId]: { ...existing, payments: [payment, ...existing.payments] }
          };
        });
        await loadSupplier(input.supplierId);
        return { id: payment.id, balance: null };
      }

      const result = await registerSupplierPayment({ ...input, branchId });
      await loadSupplier(input.supplierId);
      return result;
    },
    [branchId, loadSupplier]
  );

  return { purchases, items, payments, balance, loading, error, branchId, loadSupplier, create, editItem, registerPayment };
}
