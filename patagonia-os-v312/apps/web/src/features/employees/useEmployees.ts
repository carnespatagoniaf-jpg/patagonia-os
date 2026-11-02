import { useCallback, useEffect, useState } from "react";
import type { Employee, PayrollAdjustment, PayrollLiquidation } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import { useAuth } from "../auth/AuthProvider";
import { planAllows } from "../auth/permissions";
import { addDaysIso, todayIso } from "../shifts/format";
import {
  createEmployee,
  createPayrollAdjustment,
  closePayrollLiquidation,
  deletePayrollAdjustment,
  deletePayrollLiquidation,
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
  {
    id: "demo-emp-1",
    branchId: DEMO_BRANCH_ID,
    fullName: "Carlos Fernández",
    baseSalary: 390000,
    salaryPeriod: "weekly",
    recurringBonusAmount: 0,
    active: true
  }
];

export function useEmployees() {
  const { branchId } = useActiveBranch();
  const { profile } = useAuth();
  const employeesInPlan = planAllows(profile, "estandar");

  const [employees, setEmployees] = useState<Employee[]>(isSupabaseConfigured ? [] : DEMO_EMPLOYEES);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);

  const [adjustments, setAdjustments] = useState<PayrollAdjustment[]>([]);
  const [vouchers, setVouchers] = useState<EmployeeVoucher[]>([]);
  const [liquidations, setLiquidations] = useState<PayrollLiquidation[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    if (!employeesInPlan) {
      setEmployees([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setEmployees(await listEmployees());
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los empleados.");
    } finally {
      setLoading(false);
    }
  }, [employeesInPlan]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (input: Omit<CreateEmployeeInput, "branchId">) => {
      if (!branchId) throw new Error("Tu usuario no tiene sucursal asignada.");

      if (!isSupabaseConfigured) {
        const employee: Employee = {
          id: crypto.randomUUID(),
          branchId,
          fullName: input.fullName,
          baseSalary: input.baseSalary,
          salaryPeriod: input.salaryPeriod,
          recurringBonusAmount: input.recurringBonusAmount,
          recurringBonusReason: input.recurringBonusReason,
          active: true
        };
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
        setEmployees((current) =>
          current.map((e) =>
            e.id === input.id
              ? {
                  ...e,
                  fullName: input.fullName,
                  baseSalary: input.baseSalary,
                  salaryPeriod: input.salaryPeriod,
                  recurringBonusAmount: input.recurringBonusAmount,
                  recurringBonusReason: input.recurringBonusReason,
                  active: input.active
                }
              : e
          )
        );
        return;
      }

      await updateEmployee(input);
      await reload();
    },
    [reload]
  );

  const loadDetail = useCallback(async (employeeId: string) => {
    if (!isSupabaseConfigured) {
      // Modo demo: vales de las últimas dos semanas (unos pendientes de la semana anterior) para que se vea la pantalla con datos.
      const day = (n: number) => addDaysIso(todayIso(), -n);
      const vale = (n: number, amount: number, detail: string, type: EmployeeVoucher["type"] = "vale_adelanto", liquidated = false): EmployeeVoucher =>
        ({ id: `demo-vale-${n}-${amount}`, amount, type, detail, shiftDate: day(n), shift: "mostrador", liquidated });
      setVouchers(employeeId === "demo-emp-1" ? [
        vale(1, 120000, "vale"), vale(2, 140000, "semana"), vale(2, 21769, "mercadería", "vale_mercaderia"), vale(4, 7685, "mercadería", "vale_mercaderia"),
        vale(5, 100000, "vale"), vale(5, 27977, "mercadería", "vale_mercaderia"), vale(6, 11832, "mercadería", "vale_mercaderia"), vale(6, 20000, "efectivo"),
        vale(8, 60000, "vale"), vale(10, 28453, "mercadería", "vale_mercaderia"), vale(10, 160000, "vale"),
        vale(40, 95000, "sueldo", "vale_adelanto", true), vale(44, 50051, "mercadería", "vale_mercaderia", true)
      ] : []);
      setAdjustments(employeeId === "demo-emp-1" ? [{ id: "demo-adj-1", employeeId, adjustmentDate: day(4), type: "bonus", amount: 28000, reason: "feriado", liquidated: false }] : []);
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
        const periodDays =
          Math.round(
            (new Date(`${input.periodEnd}T00:00:00`).getTime() - new Date(`${input.periodStart}T00:00:00`).getTime()) / 86400000
          ) + 1;
        const divisor =
          employee?.salaryPeriod === "daily" ? 1 : employee?.salaryPeriod === "weekly" ? 7 : employee?.salaryPeriod === "biweekly" ? 14 : 30;
        const baseSalary = Math.round((((employee?.baseSalary ?? 0) + (employee?.recurringBonusAmount ?? 0)) * periodDays) / divisor);
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
          payments: input.payments.map((p, i) => ({ id: `demo-${i}`, accountId: p.accountId, amount: p.amount })),
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

  const removeLiquidation = useCallback(
    async (liquidationId: string, employeeId: string) => {
      if (!isSupabaseConfigured) {
        setLiquidations((current) => current.filter((l) => l.id !== liquidationId));
        return;
      }

      await deletePayrollLiquidation(liquidationId);
      await loadDetail(employeeId);
    },
    [loadDetail]
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
    liquidate,
    removeLiquidation
  };
}
