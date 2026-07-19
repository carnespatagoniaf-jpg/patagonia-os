import { useCallback, useState } from "react";
import type { ShiftOutflow, ShiftPeriod, ShiftRegister, ShiftSale } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import {
  deleteShiftOutflow,
  deleteShiftSale,
  fetchShift,
  listShiftOutflows,
  listShiftsInRange,
  listShiftSales,
  saveShift,
  saveShiftOutflow,
  saveShiftSale,
  type SaveShiftOutflowInput,
  type SaveShiftSaleInput,
  type ShiftRangeRow
} from "./shifts-service";

function shiftKey(branchId: string, date: string, shift: ShiftPeriod) {
  return `${branchId}__${date}__${shift}`;
}

export function useShifts() {
  const { branchId } = useActiveBranch();

  const [current, setCurrent] = useState<ShiftRegister | null>(null);
  const [sales, setSales] = useState<ShiftSale[]>([]);
  const [outflows, setOutflows] = useState<ShiftOutflow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [demoShifts, setDemoShifts] = useState<Record<string, ShiftRegister>>({});
  const [demoSales, setDemoSales] = useState<Record<string, ShiftSale[]>>({});
  const [demoOutflows, setDemoOutflows] = useState<Record<string, ShiftOutflow[]>>({});

  const load = useCallback(
    async (date: string, shift: ShiftPeriod) => {
      if (!branchId) return;

      if (!isSupabaseConfigured) {
        const key = shiftKey(branchId, date, shift);
        const existing = demoShifts[key] ?? null;
        setCurrent(existing);
        setSales(existing ? demoSales[existing.id] ?? [] : []);
        setOutflows(existing ? demoOutflows[existing.id] ?? [] : []);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const shiftRow = await fetchShift(branchId, date, shift);
        setCurrent(shiftRow);
        if (shiftRow) {
          const [saleList, outflowList] = await Promise.all([listShiftSales(shiftRow.id), listShiftOutflows(shiftRow.id)]);
          setSales(saleList);
          setOutflows(outflowList);
        } else {
          setSales([]);
          setOutflows([]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudo cargar el turno.");
      } finally {
        setLoading(false);
      }
    },
    [branchId, demoShifts, demoSales, demoOutflows]
  );

  const save = useCallback(
    async (date: string, shift: ShiftPeriod, openingCash: number, closingCountedCash?: number) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const key = shiftKey(branchId, date, shift);
        const existing = demoShifts[key];
        const now = new Date().toISOString();
        const shiftRow: ShiftRegister = {
          id: existing?.id ?? crypto.randomUUID(),
          branchId,
          shiftDate: date,
          shift,
          openingCash,
          closingCountedCash,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        };
        setDemoShifts((curr) => ({ ...curr, [key]: shiftRow }));
        setCurrent(shiftRow);
        return { id: shiftRow.id };
      }

      const result = await saveShift({ branchId, shiftDate: date, shift, openingCash, closingCountedCash });
      await load(date, shift);
      return result;
    },
    [branchId, demoShifts, load]
  );

  const saveSale = useCallback(
    async (input: SaveShiftSaleInput, date: string, shift: ShiftPeriod) => {
      if (!isSupabaseConfigured) {
        const sale: ShiftSale = { id: input.id ?? crypto.randomUUID(), shiftId: input.shiftId, accountId: input.accountId, amount: input.amount };
        setDemoSales((curr) => {
          const list = curr[input.shiftId] ?? [];
          const existingIndex = list.findIndex((s) => s.id === sale.id);
          const nextList = existingIndex >= 0 ? list.map((s, i) => (i === existingIndex ? sale : s)) : [...list, sale];
          return { ...curr, [input.shiftId]: nextList };
        });
        setSales((curr) => {
          const existingIndex = curr.findIndex((s) => s.id === sale.id);
          return existingIndex >= 0 ? curr.map((s, i) => (i === existingIndex ? sale : s)) : [...curr, sale];
        });
        return;
      }

      await saveShiftSale(input);
      await load(date, shift);
    },
    [load]
  );

  const removeSale = useCallback(
    async (saleId: string, shiftId: string, date: string, shift: ShiftPeriod) => {
      if (!isSupabaseConfigured) {
        setDemoSales((curr) => ({ ...curr, [shiftId]: (curr[shiftId] ?? []).filter((s) => s.id !== saleId) }));
        setSales((curr) => curr.filter((s) => s.id !== saleId));
        return;
      }

      await deleteShiftSale(saleId);
      await load(date, shift);
    },
    [load]
  );

  const saveOutflow = useCallback(
    async (input: SaveShiftOutflowInput, date: string, shift: ShiftPeriod) => {
      if (!isSupabaseConfigured) {
        const outflow: ShiftOutflow = {
          id: input.id ?? crypto.randomUUID(),
          shiftId: input.shiftId,
          accountId: input.accountId,
          type: input.type,
          amount: input.amount,
          detail: input.detail,
          employeeId: input.employeeId,
          supplierId: input.supplierId,
          createdAt: new Date().toISOString()
        };
        setDemoOutflows((curr) => {
          const list = curr[input.shiftId] ?? [];
          const existingIndex = list.findIndex((o) => o.id === outflow.id);
          const nextList = existingIndex >= 0 ? list.map((o, i) => (i === existingIndex ? outflow : o)) : [...list, outflow];
          return { ...curr, [input.shiftId]: nextList };
        });
        setOutflows((curr) => {
          const existingIndex = curr.findIndex((o) => o.id === outflow.id);
          return existingIndex >= 0 ? curr.map((o, i) => (i === existingIndex ? outflow : o)) : [...curr, outflow];
        });
        return;
      }

      await saveShiftOutflow(input);
      await load(date, shift);
    },
    [load]
  );

  const removeOutflow = useCallback(
    async (outflowId: string, shiftId: string, date: string, shift: ShiftPeriod) => {
      if (!isSupabaseConfigured) {
        setDemoOutflows((curr) => ({ ...curr, [shiftId]: (curr[shiftId] ?? []).filter((o) => o.id !== outflowId) }));
        setOutflows((curr) => curr.filter((o) => o.id !== outflowId));
        return;
      }

      await deleteShiftOutflow(outflowId);
      await load(date, shift);
    },
    [load]
  );

  const loadRange = useCallback(
    async (fromDate: string, toDate: string): Promise<ShiftRangeRow[]> => {
      if (!branchId) return [];
      if (!isSupabaseConfigured) {
        return Object.values(demoShifts)
          .filter((s) => s.shiftDate >= fromDate && s.shiftDate <= toDate)
          .map((s) => ({ shift: s, sales: demoSales[s.id] ?? [], outflows: demoOutflows[s.id] ?? [] }));
      }
      return listShiftsInRange(branchId, fromDate, toDate);
    },
    [branchId, demoShifts, demoSales, demoOutflows]
  );

  return { branchId, current, sales, outflows, loading, error, load, save, saveSale, removeSale, saveOutflow, removeOutflow, loadRange };
}
