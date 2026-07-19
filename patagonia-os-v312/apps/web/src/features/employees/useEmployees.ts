import { useCallback, useEffect, useState } from "react";
import type { Employee, PayrollAdjustment, PayrollLiquidation } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import {
  createEmployee,
  createPayrollAdjustment,
  closePayrollLiquidation,
  deletePayrollAdjustment,
  listEmployeeVouchers,
  listEmployees,
  listPayrollAdjustments,
  listPayrollLiquidations,
  updateEmployee,
  type ClosePayrollLiquidationInput,
  type CreateEmployeeInput,
  type CreatePayrollAdjustmentInput,
  type EmployeeVoucher,
  type UpdateEmployeeInput
} from "./employees-service";

const DEMO_BRANCH_ID = "demo-branch";

const DEMO_EMPLOYEES: Employee[] = [
  { id: "demo-emp-1", branchId: DEMO_BRANCH_ID, fullName: "Carlos Fernández (demo)", baseSalary: 400000, active: true }
];

export function useEmployees() {
  const { branchId } = useActiveBranch();

  const [employees, setEmployees] = useState<Employee[]>(isSupabaseConfigured ? [] : DEMO_EMPLOYEES);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const [adjustments, setAdjustments] = useState<PayrollAdjustment[]>([]);
  const [vouchers, setVouchers] = useState<EmployeeVoucher[]>([]);
  const [liquidations, setLiquidations] = useState<PayrollLiquidation[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    setError(null);
    try {
      setEmployees(await listEmployees());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los empleados.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (input: Omit<CreateEmployeeInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const employee: Employee = { id: crypto.randomUUID(), branchId, fullName: input.fullName, baseSalary: input.baseSalary, active: true };
        setEmployees((current) => [...current, employee]);
        return employee;
      }

      const result = await createEmployee({ ...input, branchId });
      await reload();
      return result;
    },
    [branchId, reload]
  );

  const update = useCallback(
    async (input: UpdateEmployeeInput) => {
      if (!isSupabaseConfigured) {
        setEmployees((current) => current.map((e) => (e.id === input.id ? { ...e, fullName: input.fullName, baseSalary: input.baseSalary, active: input.active } : e)));
        return;
      }

      await updateEmployee(input);
      await reload();
    },
    [reload]
  );

  const loadDetail = useCallback(async (employeeId: string) => {
    if (!isSupabaseConfigured) {
      setAdjustments([]);
      setVouchers([]);
      setLiquidations([]);
      return;
    }

    setDetailLoading(true);
    try {
      const [adjustmentList, voucherList, liquidationList] = await Promise.all([
        listPayrollAdjustments(employeeId),
        listEmployeeVouchers(employeeId),
        listPayrollLiquidations(employeeId)
      ]);
      setAdjustments(adjustmentList);
      setVouchers(voucherList);
      setLiquidations(liquidationList);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const addAdjustment = useCallback(
    async (input: CreatePayrollAdjustmentInput) => {
      if (!isSupabaseConfigured) {
        setAdjustments((current) => [
          { id: crypto.randomUUID(), employeeId: input.employeeId, adjustmentDate: input.adjustmentDate, type: input.type, amount: input.amount, reason: input.reason },
          ...current
        ]);
        return;
      }

      await createPayrollAdjustment(input);
      await loadDetail(input.employeeId);
    },
    [loadDetail]
  );

  const removeAdjustment = useCallback(
    async (adjustmentId: string, employeeId: string) => {
      if (!isSupabaseConfigured) {
        setAdjustments((current) => current.filter((a) => a.id !== adjustmentId));
        return;
      }

      await deletePayrollAdjustment(adjustmentId);
      await loadDetail(employeeId);
    },
    [loadDetail]
  );

  const liquidate = useCallback(
    async (input: Omit<ClosePayrollLiquidationInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const employee = employees.find((e) => e.id === input.employeeId);
        const adjustmentsTotal = adjustments
          .filter((a) => a.adjustmentDate >= input.periodStart && a.adjustmentDate <= input.periodEnd)
          .reduce((sum, a) => sum + (a.type === "bonus" ? a.amount : -a.amount), 0);
        const vouchersTotal = vouchers
          .filter((v) => v.shiftDate >= input.periodStart && v.shiftDate <= input.periodEnd)
          .reduce((sum, v) => sum + v.amount, 0);
        const baseSalary = employee?.baseSalary ?? 0;
        const liquidation: PayrollLiquidation = {
          id: crypto.randomUUID(),
          employeeId: input.employeeId,
          branchId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          baseSalary,
          adjustmentsTotal,
          vouchersTotal,
          netAmount: baseSalary + adjustmentsTotal - vouchersTotal,
          createdAt: new Date().toISOString()
        };
        setLiquidations((current) => [liquidation, ...current]);
        return liquidation;
      }

      const result = await closePayrollLiquidation({ ...input, branchId });
      await loadDetail(input.employeeId);
      return result;
    },
    [branchId, employees, adjustments, vouchers, loadDetail]
  );

  return {
    employees,
    loading,
    error,
    branchId,
    create,
    update,
    reload,
    adjustments,
    vouchers,
    liquidations,
    detailLoading,
    loadDetail,
    addAdjustment,
    removeAdjustment,
    liquidate
  };
}
