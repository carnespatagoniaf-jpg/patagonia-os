import { useEffect, useMemo, useState } from "react";
import type { PayrollAdjustmentType, PayrollLiquidation, SalaryPeriod } from "@patagonia/domain";
import { useEmployees } from "./useEmployees";
import { useTreasury } from "../shifts/useTreasury";
import { addDaysIso, formatMoney, todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";
import { isSupabaseConfigured } from "../../lib/supabase";
import { listPayrollLiquidationDetail, type PayrollLiquidationLineItem } from "./employees-service";
import { listPosCashiers } from "../sale/pos-shift-service";
import { setEmployeePosPin } from "../sale/cash-control-service";
import { earlierPending, shortDate } from "./payroll-period";
import { EmployeeBranches } from "./EmployeeBranches";
import { useAuth } from "../auth/AuthProvider";
import { planAllows } from "../auth/permissions";

const ADJUSTMENT_TYPE_LABELS: Record<PayrollAdjustmentType, string> = {
  bonus: "Premio",
  deduction: "Descuento"
};

const SALARY_PERIOD_LABELS: Record<SalaryPeriod, string> = {
  daily: "por día",
  weekly: "por semana",
  biweekly: "por quincena",
  monthly: "por mes"
};

const OUTFLOW_TYPE_LABELS: Record<string, string> = {
  vale_mercaderia: "Vale · Mercadería",
  vale_adelanto: "Vale · Adelanto"
};

const SALARY_PERIOD_DIVISOR: Record<SalaryPeriod, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30
};

interface PaymentRow {
  accountId: string;
  amount: string;
}

function daysBetweenInclusive(start: string, end: string) {
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

export function Employees() {
  const { profile } = useAuth();
  const {
    employees,
    loading,
    error,
    create,
    update,
    adjustments,
    vouchers,
    liquidations,
    detailLoading,
    loadDetail,
    addAdjustment,
    removeAdjustment,
    liquidate,
    removeLiquidation
  } = useEmployees();
  const { accounts } = useTreasury();

  const [message, setMessage] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSalary, setNewSalary] = useState("");
  const [newSalaryPeriod, setNewSalaryPeriod] = useState<SalaryPeriod>("monthly");
  const [newBonusAmount, setNewBonusAmount] = useState("");
  const [newBonusReason, setNewBonusReason] = useState("");

  const [editingEmployee, setEditingEmployee] = useState(false);
  const [editName, setEditName] = useState("");
  const [editSalary, setEditSalary] = useState("");
  const [editSalaryPeriod, setEditSalaryPeriod] = useState<SalaryPeriod>("monthly");
  const [editBonusAmount, setEditBonusAmount] = useState("");
  const [editBonusReason, setEditBonusReason] = useState("");
  const [editActive, setEditActive] = useState(true);

  const [paymentRows, setPaymentRows] = useState<PaymentRow[]>([{ accountId: "", amount: "" }]);

  const [adjDate, setAdjDate] = useState(todayIso());
  const [adjType, setAdjType] = useState<PayrollAdjustmentType>("bonus");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjReason, setAdjReason] = useState("");
  const [showAdjForm, setShowAdjForm] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [historyTab, setHistoryTab] = useState<"liquidations" | "liquidated">("liquidations");
  const [showAllLiquidations, setShowAllLiquidations] = useState(false);

  const [periodStart, setPeriodStart] = useState(addDaysIso(todayIso(), -6));
  const [periodEnd, setPeriodEnd] = useState(todayIso());

  // PIN de caja (migración 117): quién atiende Mostrador. Solo se sabe quién
  // tiene PIN, nunca el PIN.
  const [pinHolders, setPinHolders] = useState<Set<string>>(new Set());
  const [pinInput, setPinInput] = useState("");
  const [pinBusy, setPinBusy] = useState(false);

  async function reloadPinHolders() {
    if (!isSupabaseConfigured) return;
    try {
      const cashiers = await listPosCashiers(null);
      setPinHolders(new Set(cashiers.map((c) => c.employeeId)));
    } catch {
      setPinHolders(new Set());
    }
  }

  useEffect(() => {
    void reloadPinHolders();
  }, []);

  async function handleSavePin(employeeId: string, pin: string | null) {
    setMessage("");
    if (pin !== null && !/^[0-9]{4,6}$/.test(pin.trim())) {
      setMessage("El PIN de caja tiene que ser de 4 a 6 números.");
      return;
    }
    setPinBusy(true);
    try {
      await setEmployeePosPin(employeeId, pin === null ? null : pin.trim());
      setPinInput("");
      await reloadPinHolders();
      setMessage(pin === null ? "PIN de caja quitado." : "PIN de caja guardado. Desde ahora, para abrir y cerrar la caja en Mostrador se elige quién atiende y se pone su PIN.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar el PIN.");
    } finally {
      setPinBusy(false);
    }
  }

  const [receipt, setReceipt] = useState<{ liquidation: PayrollLiquidation; items: PayrollLiquidationLineItem[] } | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const selectedEmployee = employees.find((e) => e.id === selectedId) ?? null;

  // Arranca con el primero elegido: la derecha nunca queda vacía.
  useEffect(() => {
    if (!selectedId && employees.length > 0) setSelectedId(employees[0].id);
  }, [selectedId, employees]);

  useEffect(() => {
    if (selectedEmployee) {
      setEditName(selectedEmployee.fullName);
      setEditSalary(String(selectedEmployee.baseSalary));
      setEditSalaryPeriod(selectedEmployee.salaryPeriod);
      setEditBonusAmount(selectedEmployee.recurringBonusAmount ? String(selectedEmployee.recurringBonusAmount) : "");
      setEditBonusReason(selectedEmployee.recurringBonusReason ?? "");
      setEditActive(selectedEmployee.active);
      setEditingEmployee(false);
      setShowPin(false);
      setShowAdjForm(false);
      setShowAllLiquidations(false);
    }
  }, [selectedEmployee]);

  const periodAdjustments = useMemo(
    // Los ya liquidados no se vuelven a sumar (igual que la base: no permite liquidaciones superpuestas, así que un premio ya liquidado no se vuelve a cobrar).
    () => adjustments.filter((a) => !a.liquidated && a.adjustmentDate >= periodStart && a.adjustmentDate <= periodEnd),
    [adjustments, periodStart, periodEnd]
  );

  const periodAdjustmentsTotal = useMemo(
    () => periodAdjustments.reduce((sum, a) => sum + (a.type === "bonus" ? a.amount : -a.amount), 0),
    [periodAdjustments]
  );

  // Acotado a [periodStart, periodEnd], igual que los premios/descuentos y
  // que la RPC en el backend: un vale pendiente de una semana anterior que
  // quedó sin liquidar no se cuela acá, para no inflar el descuento de esta
  // liquidación. Sigue viéndose como "Pendiente" en la tabla de abajo hasta
  // que se elija un rango que lo cubra.
  const periodPendingVouchers = useMemo(
    () => vouchers.filter((v) => !v.liquidated && v.shiftDate >= periodStart && v.shiftDate <= periodEnd),
    [vouchers, periodStart, periodEnd]
  );

  const periodVouchersTotal = useMemo(
    () => periodPendingVouchers.reduce((sum, v) => sum + v.amount, 0),
    [periodPendingVouchers]
  );

  const previewBaseSalary = useMemo(() => {
    if (!selectedEmployee) return 0;
    const days = daysBetweenInclusive(periodStart, periodEnd);
    const divisor = SALARY_PERIOD_DIVISOR[selectedEmployee.salaryPeriod];
    return Math.round(((selectedEmployee.baseSalary + selectedEmployee.recurringBonusAmount) * days) / divisor);
  }, [selectedEmployee, periodStart, periodEnd]);

  const previewNet = previewBaseSalary + periodAdjustmentsTotal - periodVouchersTotal;

  const isSplit = paymentRows.length > 1;
  const paymentsTotal = paymentRows.reduce((sum, p) => sum + (parseAmount(p.amount || "0") || 0), 0);
  const paymentsRemaining = previewNet - paymentsTotal;

  useEffect(() => {
    setPaymentRows([{ accountId: "", amount: previewNet > 0 ? String(previewNet) : "" }]);
    setReceipt(null);
  }, [selectedId, periodStart, periodEnd]);

  function addPaymentRow() {
    setPaymentRows((current) => [...current, { accountId: "", amount: "" }]);
  }

  function removePaymentRow(index: number) {
    setPaymentRows((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current));
  }

  function updatePaymentRow(index: number, field: "accountId" | "amount", value: string) {
    setPaymentRows((current) => current.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  }

  async function handleCreate() {
    try {
      if (!newName.trim()) throw new Error("El nombre es obligatorio.");
      const baseSalary = parseAmount(newSalary || "0");
      if (!Number.isFinite(baseSalary) || baseSalary < 0) throw new Error("El sueldo no puede ser negativo.");
      const bonusAmount = parseAmount(newBonusAmount || "0");
      if (!Number.isFinite(bonusAmount) || bonusAmount < 0) throw new Error("El premio fijo no puede ser negativo.");
      if (bonusAmount > 0 && !newBonusReason.trim()) throw new Error("El premio fijo necesita un motivo.");
      const employee = await create({
        fullName: newName.trim(),
        baseSalary,
        salaryPeriod: newSalaryPeriod,
        recurringBonusAmount: bonusAmount,
        recurringBonusReason: bonusAmount > 0 ? newBonusReason.trim() : undefined
      });
      setNewName("");
      setNewSalary("");
      setNewSalaryPeriod("monthly");
      setNewBonusAmount("");
      setNewBonusReason("");
      setShowNewForm(false);
      setSelectedId(employee.id);
      setMessage("Empleado creado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear el empleado.");
    }
  }

  async function handleUpdate() {
    try {
      if (!selectedEmployee) return;
      if (!editName.trim()) throw new Error("El nombre es obligatorio.");
      const baseSalary = parseAmount(editSalary);
      if (!Number.isFinite(baseSalary) || baseSalary < 0) throw new Error("El sueldo no puede ser negativo.");
      const bonusAmount = parseAmount(editBonusAmount || "0");
      if (!Number.isFinite(bonusAmount) || bonusAmount < 0) throw new Error("El premio fijo no puede ser negativo.");
      if (bonusAmount > 0 && !editBonusReason.trim()) throw new Error("El premio fijo necesita un motivo.");
      await update({
        id: selectedEmployee.id,
        fullName: editName.trim(),
        baseSalary,
        salaryPeriod: editSalaryPeriod,
        recurringBonusAmount: bonusAmount,
        recurringBonusReason: bonusAmount > 0 ? editBonusReason.trim() : undefined,
        active: editActive
      });
      setEditingEmployee(false);
      setMessage("Empleado actualizado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo actualizar el empleado.");
    }
  }

  async function handleAddAdjustment() {
    try {
      if (!selectedEmployee) return;
      const amount = parseAmount(adjAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!adjReason.trim()) throw new Error("Ingresá un motivo.");
      await addAdjustment({ employeeId: selectedEmployee.id, adjustmentDate: adjDate, type: adjType, amount, reason: adjReason.trim() });
      setAdjAmount("");
      setAdjReason("");
      setShowAdjForm(false);
      setMessage(adjType === "bonus" ? "Premio cargado." : "Descuento cargado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar el ajuste.");
    }
  }

  async function handleRemoveAdjustment(id: string) {
    if (!window.confirm("¿Seguro que querés quitar este premio/descuento? No se puede deshacer.")) return;
    try {
      if (!selectedEmployee) return;
      await removeAdjustment(id, selectedEmployee.id);
      setMessage("Ajuste eliminado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo eliminar el ajuste.");
    }
  }

  async function handleLiquidate() {
    try {
      if (!selectedEmployee) return;

      const rowsWithAccount = paymentRows.filter((p) => p.accountId);
      if (rowsWithAccount.length > 0) {
        if (rowsWithAccount.length !== paymentRows.length) {
          throw new Error("Elegí una cuenta para cada pago, o dejalos todos vacíos.");
        }
        if (previewNet <= 0) {
          throw new Error("El neto no es positivo, no hay nada que pagar desde Tesorería.");
        }
        if (Math.abs(paymentsRemaining) > 0.01) {
          throw new Error(`Los pagos no suman el neto: faltan ${formatMoney(paymentsRemaining)}.`);
        }
      }

      const payments = rowsWithAccount.map((p) => ({ accountId: p.accountId, amount: parseAmount(p.amount || "0") || 0 }));

      const result = await liquidate({
        employeeId: selectedEmployee.id,
        periodStart,
        periodEnd,
        payments
      });
      setPaymentRows([{ accountId: "", amount: "" }]);
      setMessage(`Liquidación registrada: neto ${formatMoney(result.netAmount)}.`);
      await handleViewReceipt({
        ...result,
        payments: payments.map((p, i) => ({ id: `local-${i}`, accountId: p.accountId, accountName: accounts.find((a) => a.id === p.accountId)?.name, amount: p.amount }))
      });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo liquidar el período.");
    }
  }

  async function handleViewReceipt(liquidation: PayrollLiquidation) {
    if (!isSupabaseConfigured) {
      const items: PayrollLiquidationLineItem[] = [
        ...periodAdjustments.map((a) => ({ date: a.adjustmentDate, label: a.reason, amount: a.amount, kind: a.type as "bonus" | "deduction" })),
        ...periodPendingVouchers.map((v) => ({ date: v.shiftDate, label: v.detail, amount: v.amount, kind: "voucher" as const }))
      ].sort((a, b) => a.date.localeCompare(b.date));
      setReceipt({ liquidation, items });
      return;
    }

    setReceiptLoading(true);
    try {
      const items = await listPayrollLiquidationDetail(liquidation.id);
      setReceipt({ liquidation, items });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar el detalle de la liquidación.");
    } finally {
      setReceiptLoading(false);
    }
  }

  async function handleRemoveLiquidation(id: string) {
    if (!window.confirm("¿Seguro que querés borrar esta liquidación? Los vales y ajustes que cubría vuelven a quedar pendientes. No se puede deshacer.")) return;
    try {
      if (!selectedEmployee) return;
      await removeLiquidation(id, selectedEmployee.id);
      setMessage("Liquidación eliminada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo eliminar la liquidación.");
    }
  }


  function handlePrint() {
    window.print();
  }

  // Lo que quedó pendiente de antes del "desde" (2026-11-02: vales de la semana anterior quedaban colgados sin que nadie los viera).
  const earlier = useMemo(
    () =>
      earlierPending(
        [
          ...vouchers.filter((v) => !v.liquidated && v.shiftDate !== "-").map((v) => ({ date: v.shiftDate, kind: "voucher" as const, amount: -v.amount })),
          ...adjustments.filter((a) => !a.liquidated).map((a) => ({ date: a.adjustmentDate, kind: "adjustment" as const, amount: a.type === "bonus" ? a.amount : -a.amount }))
        ],
        periodStart,
        liquidations
      ),
    [vouchers, adjustments, liquidations, periodStart]
  );
  const earlierVouchers = earlier.includable.filter((i) => i.kind === "voucher");
  const earlierAdjustments = earlier.includable.filter((i) => i.kind === "adjustment");
  const stuckVouchers = earlier.stuck.filter((i) => i.kind === "voucher");

  const liquidatedRows = useMemo(
    () =>
      [
        ...vouchers.filter((v) => v.liquidated).map((v) => ({ id: v.id, date: v.shiftDate, label: `${OUTFLOW_TYPE_LABELS[v.type] ?? v.type} · ${v.detail}`, amount: -v.amount })),
        ...adjustments.filter((a) => a.liquidated).map((a) => ({ id: a.id, date: a.adjustmentDate, label: `${ADJUSTMENT_TYPE_LABELS[a.type]} · ${a.reason}`, amount: a.type === "bonus" ? a.amount : -a.amount }))
      ].sort((a, b) => b.date.localeCompare(a.date)),
    [vouchers, adjustments]
  );
  const visibleLiquidations = showAllLiquidations ? liquidations : liquidations.slice(0, 5);

  function setPeriod(days: number) {
    setPeriodStart(addDaysIso(todayIso(), -(days - 1)));
    setPeriodEnd(todayIso());
  }
  const periodDays = daysBetweenInclusive(periodStart, periodEnd);
  const activePreset = periodEnd === todayIso() && [7, 15, 30].includes(periodDays) ? periodDays : null;

  return (
    <>
      <header className="page-header no-print">
        <div>
          <p className="eyebrow">EMPLEADOS</p>
          <h1>Sueldos y vales</h1>
          <p className="muted">Sueldo, premios, descuentos y vales — enlazado con las salidas de caja.</p>
        </div>
      </header>

      {message && <div className="message no-print">{message}</div>}
      {error && <div className="message warning no-print">{error}</div>}

      <div className="emp-layout">
        <section className="panel emp-list no-print">
          <div className="panel-title">
            <h2>Empleados</h2>
            {!showNewForm && <button className="secondary" onClick={() => setShowNewForm(true)}>+ Nuevo</button>}
          </div>
          {showNewForm && (
            <div className="form-box" style={{ marginBottom: 12 }}>
              <div className="form-grid">
                <label>Nombre<input value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
                <label>Sueldo base<input type="text" inputMode="decimal" value={newSalary} onChange={(e) => setNewSalary(e.target.value)} /></label>
                <label>Se paga
                  <select value={newSalaryPeriod} onChange={(e) => setNewSalaryPeriod(e.target.value as SalaryPeriod)}>
                    <option value="monthly">Por mes</option>
                    <option value="biweekly">Por quincena</option>
                    <option value="weekly">Por semana</option>
                    <option value="daily">Por día</option>
                  </select>
                </label>
                <label>Premio fijo (opcional)<input type="text" inputMode="decimal" value={newBonusAmount} onChange={(e) => setNewBonusAmount(e.target.value)} /></label>
                <label>Motivo del premio fijo<input value={newBonusReason} onChange={(e) => setNewBonusReason(e.target.value)} /></label>
              </div>
              <div className="form-actions">
                <button onClick={handleCreate}>Guardar empleado</button>
                <button className="secondary" onClick={() => setShowNewForm(false)}>Cancelar</button>
              </div>
            </div>
          )}
          {loading && <p className="muted">Cargando…</p>}
          <div className="emp-list-items">
            {employees.map((employee) => (
              <button
                key={employee.id}
                className={employee.id === selectedId ? "emp-item active" : "emp-item"}
                onClick={() => setSelectedId(employee.id)}
              >
                <b>{employee.fullName}</b>
                <small>{formatMoney(employee.baseSalary)} {SALARY_PERIOD_LABELS[employee.salaryPeriod]}</small>
              </button>
            ))}
          </div>
          {!loading && employees.length === 0 && <p className="muted">Todavía no cargaste empleados.</p>}
        </section>

        <section className="panel emp-main print-area">
          {!selectedEmployee && <p className="muted">Elegí un empleado de la lista para liquidarle el sueldo.</p>}
          {selectedEmployee && (
            <>
              <div className="emp-head">
                <div>
                  <h2>{selectedEmployee.fullName}</h2>
                  <p className="muted">
                    Sueldo {formatMoney(selectedEmployee.baseSalary)} {SALARY_PERIOD_LABELS[selectedEmployee.salaryPeriod]}
                    {selectedEmployee.recurringBonusAmount > 0 && ` · Premio fijo ${formatMoney(selectedEmployee.recurringBonusAmount)} (${selectedEmployee.recurringBonusReason})`}
                    {!selectedEmployee.active && " · Inactivo"}
                    {isSupabaseConfigured && <span className="no-print"> · PIN de caja: {pinHolders.has(selectedEmployee.id) ? "sí" : "no"}</span>}
                  </p>
                </div>
                <div className="row-actions no-print">
                  <button className="secondary" onClick={() => { setEditingEmployee((v) => !v); setShowPin(false); }}>Editar</button>
                  {isSupabaseConfigured && <button className="secondary" onClick={() => { setShowPin((v) => !v); setEditingEmployee(false); }}>PIN de caja</button>}
                  <button className="secondary" onClick={handlePrint}>Imprimir</button>
                </div>
              </div>

              {editingEmployee && (
                <div className="form-box no-print">
                  <div className="form-grid">
                    <label>Nombre<input value={editName} onChange={(e) => setEditName(e.target.value)} /></label>
                    <label>Sueldo base<input type="text" inputMode="decimal" value={editSalary} onChange={(e) => setEditSalary(e.target.value)} /></label>
                    <label>Se paga
                      <select value={editSalaryPeriod} onChange={(e) => setEditSalaryPeriod(e.target.value as SalaryPeriod)}>
                        <option value="monthly">Por mes</option>
                        <option value="biweekly">Por quincena</option>
                        <option value="weekly">Por semana</option>
                        <option value="daily">Por día</option>
                      </select>
                    </label>
                    <label>Premio fijo (opcional)<input type="text" inputMode="decimal" value={editBonusAmount} onChange={(e) => setEditBonusAmount(e.target.value)} /></label>
                    <label>Motivo del premio fijo<input value={editBonusReason} onChange={(e) => setEditBonusReason(e.target.value)} /></label>
                    <label>Estado
                      <select value={editActive ? "1" : "0"} onChange={(e) => setEditActive(e.target.value === "1")}>
                        <option value="1">Activo</option>
                        <option value="0">Inactivo (eliminado)</option>
                      </select>
                    </label>
                  </div>
                  <div className="form-actions">
                    <button onClick={handleUpdate}>Guardar</button>
                    <button className="secondary" onClick={() => setEditingEmployee(false)}>Cancelar</button>
                  </div>
                </div>
              )}

              {showPin && isSupabaseConfigured && (
                <div className="form-box no-print">
                  <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
                    Si atiende la caja, ponele un PIN de 4 a 6 números. Al abrir y cerrar la caja en Mostrador elige su nombre y pone el PIN, así cada cierre y cada retiro queda con su nombre.
                  </p>
                  <div className="row-actions">
                    <input
                      type="password"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder={pinHolders.has(selectedEmployee.id) ? "PIN nuevo" : "PIN"}
                      value={pinInput}
                      onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ""))}
                      style={{ width: 120 }}
                    />
                    <button disabled={pinBusy || !pinInput} onClick={() => handleSavePin(selectedEmployee.id, pinInput)}>
                      {pinHolders.has(selectedEmployee.id) ? "Cambiar PIN" : "Guardar PIN"}
                    </button>
                    {pinHolders.has(selectedEmployee.id) && (
                      <button className="secondary" disabled={pinBusy} onClick={() => handleSavePin(selectedEmployee.id, null)}>Quitar PIN</button>
                    )}
                  </div>
                  {planAllows(profile, "empresa") && <EmployeeBranches employee={selectedEmployee} />}
                </div>
              )}

              {receipt ? (
                <>
                  <div className="emp-period">
                    <b>Recibo de liquidación</b>
                    <span className="muted">del {receipt.liquidation.periodStart} al {receipt.liquidation.periodEnd}{receiptLoading && " · Cargando detalle…"}</span>
                    <button className="secondary no-print" onClick={() => setReceipt(null)}>Liquidar otro período</button>
                  </div>
                  <div className="emp-summary">
                    <div><span>Sueldo del período</span><strong>{formatMoney(receipt.liquidation.baseSalary)}</strong></div>
                    <div><span>Premios − descuentos</span><strong>{formatMoney(receipt.liquidation.adjustmentsTotal)}</strong></div>
                    <div><span>Vales</span><strong>{formatMoney(receipt.liquidation.vouchersTotal)}</strong></div>
                    <div className="total"><span>Neto pagado</span><strong>{formatMoney(receipt.liquidation.netAmount)}</strong></div>
                  </div>
                  {receipt.items.length > 0 && (
                    <div className="emp-box" style={{ marginTop: 14 }}>
                      <h3>Detalle</h3>
                      <table className="data-table no-stack">
                        <tbody>
                          {receipt.items.map((item, i) => (
                            <tr key={i}>
                              <td className="emp-date">{shortDate(item.date)}</td>
                              <td>{item.kind === "voucher" ? `Vale · ${item.label}` : `${ADJUSTMENT_TYPE_LABELS[item.kind]} · ${item.label}`}</td>
                              <td className={`num ${item.kind === "bonus" ? "num-positive" : "num-negative"}`}>
                                {item.kind === "bonus" ? "+" : "−"} {formatMoney(item.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p style={{ marginTop: 14 }}>
                    <b>Forma de pago: </b>
                    {receipt.liquidation.payments.length === 0
                      ? "Sin cuenta (ya se pagó por afuera del sistema)"
                      : receipt.liquidation.payments.map((p) => `${p.accountName ?? "Cuenta"}: ${formatMoney(p.amount)}`).join(" + ")}
                  </p>
                </>
              ) : (
                <>
                  <div className="emp-period">
                    <b>Liquidar</b>
                    <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
                    <span className="muted">a</span>
                    <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
                    <div className="emp-seg no-print">
                      <button className={activePreset === 7 ? "active" : ""} onClick={() => setPeriod(7)}>Semana</button>
                      <button className={activePreset === 15 ? "active" : ""} onClick={() => setPeriod(15)}>Quincena</button>
                      <button className={activePreset === 30 ? "active" : ""} onClick={() => setPeriod(30)}>Mes</button>
                    </div>
                    {detailLoading && <span className="muted">Cargando…</span>}
                  </div>

                  <div className="emp-summary">
                    <div><span>Sueldo ({periodDays} {periodDays === 1 ? "día" : "días"})</span><strong>{formatMoney(previewBaseSalary)}</strong></div>
                    <div>
                      <span>Premios − descuentos</span>
                      <strong className={periodAdjustmentsTotal > 0 ? "num-positive" : periodAdjustmentsTotal < 0 ? "num-negative" : ""}>
                        {periodAdjustmentsTotal > 0 ? "+ " : periodAdjustmentsTotal < 0 ? "− " : ""}{formatMoney(Math.abs(periodAdjustmentsTotal))}
                      </strong>
                    </div>
                    <div>
                      <span>Vales ({periodPendingVouchers.length})</span>
                      <strong className={periodVouchersTotal > 0 ? "num-negative" : ""}>{periodVouchersTotal > 0 ? "− " : ""}{formatMoney(periodVouchersTotal)}</strong>
                    </div>
                    <div className={previewNet < 0 ? "total negative" : "total"}>
                      <span>Neto a pagar</span>
                      <strong>{previewNet < 0 ? "− " : ""}{formatMoney(Math.abs(previewNet))}</strong>
                      {previewNet < 0 && <small>Le debe al negocio</small>}
                    </div>
                  </div>

                  {earlier.includeFrom && (
                    <div className="emp-note no-print">
                      <span>
                        Tiene{" "}
                        {earlierVouchers.length > 0 && <b>{earlierVouchers.length} {earlierVouchers.length === 1 ? "vale pendiente" : "vales pendientes"} ({formatMoney(-earlierVouchers.reduce((s, i) => s + i.amount, 0))})</b>}
                        {earlierVouchers.length > 0 && earlierAdjustments.length > 0 && " y "}
                        {earlierAdjustments.length > 0 && <b>{earlierAdjustments.length} {earlierAdjustments.length === 1 ? "premio/descuento" : "premios/descuentos"}</b>}
                        {" "}de antes del {shortDate(periodStart)} que no entran en esta liquidación.
                      </span>
                      <button className="secondary" onClick={() => setPeriodStart(earlier.includeFrom!)}>Liquidar desde el {shortDate(earlier.includeFrom)}</button>
                    </div>
                  )}
                  {stuckVouchers.length > 0 && (
                    <div className="emp-note no-print">
                      <span>
                        {stuckVouchers.length === 1 ? "Hay 1 vale pendiente" : `Hay ${stuckVouchers.length} vales pendientes`} ({formatMoney(-stuckVouchers.reduce((s, i) => s + i.amount, 0))}) con fecha de días que ya se liquidaron. Para descontarlos, borrá la liquidación de esos días (abajo) y volvé a liquidar.
                      </span>
                    </div>
                  )}

                  <div className="emp-cols">
                    <div className="emp-box">
                      <h3>Vales del período <span>{periodPendingVouchers.length} · {formatMoney(periodVouchersTotal)}</span></h3>
                      {periodPendingVouchers.length === 0 ? (
                        <p className="muted emp-empty">No hay vales en estas fechas.</p>
                      ) : (
                        <div className="emp-scroll">
                          <table className="data-table no-stack">
                            <tbody>
                              {periodPendingVouchers.map((v) => (
                                <tr key={v.id}>
                                  <td className="emp-date">{shortDate(v.shiftDate)}</td>
                                  <td>{v.detail}</td>
                                  <td><span className={v.type === "vale_mercaderia" ? "badge info" : "badge"}>{v.type === "vale_mercaderia" ? "Mercadería" : "Adelanto"}</span></td>
                                  <td className="num">{formatMoney(v.amount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    <div className="emp-box">
                      <h3>Premios y descuentos <span>{periodAdjustmentsTotal >= 0 ? "+" : "−"} {formatMoney(Math.abs(periodAdjustmentsTotal))}</span></h3>
                      {periodAdjustments.length === 0 && !showAdjForm && <p className="muted emp-empty">No hay premios ni descuentos en estas fechas.</p>}
                      {periodAdjustments.length > 0 && (
                        <div className="emp-scroll">
                          <table className="data-table no-stack">
                            <tbody>
                              {periodAdjustments.map((a) => (
                                <tr key={a.id}>
                                  <td className="emp-date">{shortDate(a.adjustmentDate)}</td>
                                  <td>{ADJUSTMENT_TYPE_LABELS[a.type]} · {a.reason}</td>
                                  <td className={`num ${a.type === "deduction" ? "num-negative" : "num-positive"}`}>{a.type === "deduction" ? "−" : "+"} {formatMoney(a.amount)}</td>
                                  <td className="no-print" style={{ width: 1 }}><button className="danger" onClick={() => handleRemoveAdjustment(a.id)}>Quitar</button></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {showAdjForm ? (
                        <div className="emp-adj-form no-print">
                          <input type="date" value={adjDate} onChange={(e) => setAdjDate(e.target.value)} />
                          <input type="text" inputMode="decimal" placeholder="Monto" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} />
                          <input placeholder="Motivo" value={adjReason} onChange={(e) => setAdjReason(e.target.value)} />
                          <div className="row-actions">
                            <button onClick={handleAddAdjustment}>Agregar {adjType === "bonus" ? "premio" : "descuento"}</button>
                            <button className="secondary" onClick={() => setShowAdjForm(false)}>Cancelar</button>
                          </div>
                        </div>
                      ) : (
                        <div className="row-actions emp-adj-buttons no-print">
                          <button className="secondary" onClick={() => { setAdjType("bonus"); setShowAdjForm(true); }}>+ Premio</button>
                          <button className="secondary" onClick={() => { setAdjType("deduction"); setShowAdjForm(true); }}>+ Descuento</button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="emp-pay no-print">
                    <div className="emp-pay-rows">
                      {paymentRows.map((p, i) => (
                        <div key={i} className="emp-pay-row">
                          <b className={i === 0 ? "" : "emp-pay-spacer"}>Pagar desde</b>
                          <select value={p.accountId} onChange={(e) => updatePaymentRow(i, "accountId", e.target.value)}>
                            <option value="">Sin cuenta (ya se pagó por afuera)</option>
                            {accounts.map((a) => (
                              <option key={a.id} value={a.id}>{a.name}</option>
                            ))}
                          </select>
                          {isSplit && (
                            <input type="text" inputMode="decimal" placeholder="Monto" value={p.amount} onChange={(e) => updatePaymentRow(i, "amount", e.target.value)} style={{ width: 130 }} />
                          )}
                          {isSplit && <button className="secondary" onClick={() => removePaymentRow(i)}>Quitar</button>}
                        </div>
                      ))}
                      {paymentRows[0]?.accountId && (
                        <div className="emp-pay-row">
                          <span className="emp-pay-spacer" />
                          <button className="secondary" onClick={addPaymentRow}>+ Dividir en otra cuenta</button>
                          {isSplit && Math.abs(paymentsRemaining) > 0.01 && <span className="num-negative">Faltan {formatMoney(paymentsRemaining)} para cubrir el neto.</span>}
                        </div>
                      )}
                    </div>
                    <button className="charge-button emp-pay-go" onClick={handleLiquidate}>Registrar liquidación</button>
                  </div>
                  <p className="muted no-print" style={{ margin: "8px 0 0", fontSize: 13 }}>
                    Si elegís una cuenta, el neto sale de ahí al liquidar. Sin cuenta, la liquidación queda registrada pero no mueve Tesorería.
                  </p>
                </>
              )}
            </>
          )}
        </section>
      </div>

      {selectedEmployee && (
        <section className="panel no-print" style={{ marginTop: 16 }}>
          <div className="page-tabs">
            <button className={historyTab === "liquidations" ? "page-tab active" : "page-tab"} onClick={() => setHistoryTab("liquidations")}>
              Liquidaciones anteriores <span className="badge">{liquidations.length}</span>
            </button>
            <button className={historyTab === "liquidated" ? "page-tab active" : "page-tab"} onClick={() => setHistoryTab("liquidated")}>
              Vales y premios ya liquidados <span className="badge">{liquidatedRows.length}</span>
            </button>
          </div>

          {historyTab === "liquidations" && (
            <>
              {liquidations.length === 0 ? (
                <p className="muted">Todavía no hay liquidaciones registradas.</p>
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr><th>Período</th><th className="num hide-sm">Sueldo</th><th className="num hide-sm">Premios/desc.</th><th className="num hide-sm">Vales</th><th className="num">Neto</th><th className="hide-md">Pagado desde</th><th></th></tr>
                    </thead>
                    <tbody>
                      {visibleLiquidations.map((l) => (
                        <tr key={l.id}>
                          <td>{shortDate(l.periodStart)} al {shortDate(l.periodEnd)}/{l.periodEnd.slice(2, 4)}</td>
                          <td className="num hide-sm">{formatMoney(l.baseSalary)}</td>
                          <td className="num hide-sm">{formatMoney(l.adjustmentsTotal)}</td>
                          <td className="num hide-sm">{formatMoney(l.vouchersTotal)}</td>
                          <td className={l.netAmount < 0 ? "num num-negative" : "num"}>{formatMoney(l.netAmount)}</td>
                          <td className="hide-md">{l.payments.length > 0 ? l.payments.map((p) => p.accountName ?? "Cuenta").join(" + ") : "—"}</td>
                          <td>
                            <div className="row-actions">
                              <button className="secondary" onClick={() => handleViewReceipt(l)}>Ver / Imprimir</button>
                              <button className="danger" onClick={() => handleRemoveLiquidation(l.id)}>Borrar</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {liquidations.length > 5 && (
                <button className="secondary" style={{ marginTop: 10 }} onClick={() => setShowAllLiquidations((v) => !v)}>
                  {showAllLiquidations ? "Ver solo las últimas 5" : `Ver las ${liquidations.length}`}
                </button>
              )}
            </>
          )}

          {historyTab === "liquidated" && (
            liquidatedRows.length === 0 ? (
              <p className="muted">Todavía no hay vales ni premios liquidados.</p>
            ) : (
              <div className="emp-scroll tall">
                <table className="data-table no-stack">
                  <tbody>
                    {liquidatedRows.map((row) => (
                      <tr key={row.id}>
                        <td className="emp-date">{shortDate(row.date)}/{row.date.slice(2, 4)}</td>
                        <td>{row.label}</td>
                        <td className={row.amount < 0 ? "num num-negative" : "num num-positive"}>{row.amount < 0 ? "−" : "+"} {formatMoney(Math.abs(row.amount))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </section>
      )}
    </>
  );
}
