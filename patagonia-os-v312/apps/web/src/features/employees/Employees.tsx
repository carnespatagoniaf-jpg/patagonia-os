import { useEffect, useMemo, useState } from "react";
import type { PayrollAdjustmentType, SalaryPeriod } from "@patagonia/domain";
import { useEmployees } from "./useEmployees";
import { useTreasury } from "../shifts/useTreasury";
import { addDaysIso, formatMoney, todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";

const ADJUSTMENT_TYPE_LABELS: Record<PayrollAdjustmentType, string> = {
  bonus: "Premio",
  deduction: "Descuento"
};

const SALARY_PERIOD_LABELS: Record<SalaryPeriod, string> = {
  weekly: "por semana",
  monthly: "por mes"
};

const OUTFLOW_TYPE_LABELS: Record<string, string> = {
  vale_mercaderia: "Vale · Mercadería",
  vale_adelanto: "Vale · Adelanto"
};

function daysBetweenInclusive(start: string, end: string) {
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

export function Employees() {
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

  const [editingEmployee, setEditingEmployee] = useState(false);
  const [editName, setEditName] = useState("");
  const [editSalary, setEditSalary] = useState("");
  const [editSalaryPeriod, setEditSalaryPeriod] = useState<SalaryPeriod>("monthly");
  const [editActive, setEditActive] = useState(true);

  const [liquidationAccountId, setLiquidationAccountId] = useState("");

  const [adjDate, setAdjDate] = useState(todayIso());
  const [adjType, setAdjType] = useState<PayrollAdjustmentType>("bonus");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjReason, setAdjReason] = useState("");

  const [periodStart, setPeriodStart] = useState(addDaysIso(todayIso(), -6));
  const [periodEnd, setPeriodEnd] = useState(todayIso());

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const selectedEmployee = employees.find((e) => e.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedEmployee) {
      setEditName(selectedEmployee.fullName);
      setEditSalary(String(selectedEmployee.baseSalary));
      setEditSalaryPeriod(selectedEmployee.salaryPeriod);
      setEditActive(selectedEmployee.active);
      setEditingEmployee(false);
    }
  }, [selectedEmployee]);

  const periodAdjustmentsTotal = useMemo(
    () =>
      adjustments
        .filter((a) => a.adjustmentDate >= periodStart && a.adjustmentDate <= periodEnd)
        .reduce((sum, a) => sum + (a.type === "bonus" ? a.amount : -a.amount), 0),
    [adjustments, periodStart, periodEnd]
  );

  // Un vale queda "pendiente" hasta que una liquidación lo cubre explícitamente
  // (marcado en el backend), sin importar fechas: así ningún vale se pierde ni
  // se descuenta dos veces, sin importar qué rango esté elegido en pantalla.
  const periodVouchersTotal = useMemo(
    () => vouchers.filter((v) => !v.liquidated && v.shiftDate <= periodEnd).reduce((sum, v) => sum + v.amount, 0),
    [vouchers, periodEnd]
  );

  const previewBaseSalary = useMemo(() => {
    if (!selectedEmployee) return 0;
    const days = daysBetweenInclusive(periodStart, periodEnd);
    const divisor = selectedEmployee.salaryPeriod === "weekly" ? 7 : 30;
    return Math.round((selectedEmployee.baseSalary * days) / divisor);
  }, [selectedEmployee, periodStart, periodEnd]);

  const previewNet = previewBaseSalary + periodAdjustmentsTotal - periodVouchersTotal;

  async function handleCreate() {
    try {
      if (!newName.trim()) throw new Error("El nombre es obligatorio.");
      const baseSalary = parseAmount(newSalary || "0");
      if (!Number.isFinite(baseSalary) || baseSalary < 0) throw new Error("El sueldo no puede ser negativo.");
      const employee = await create({ fullName: newName.trim(), baseSalary, salaryPeriod: newSalaryPeriod });
      setNewName("");
      setNewSalary("");
      setNewSalaryPeriod("monthly");
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
      await update({ id: selectedEmployee.id, fullName: editName.trim(), baseSalary, salaryPeriod: editSalaryPeriod, active: editActive });
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
      setMessage("Ajuste cargado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar el ajuste.");
    }
  }

  async function handleRemoveAdjustment(id: string) {
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
      if (!liquidationAccountId) throw new Error("Elegí de qué cuenta sale el pago del sueldo.");
      const result = await liquidate({ employeeId: selectedEmployee.id, periodStart, periodEnd, accountId: liquidationAccountId });
      setLiquidationAccountId("");
      setMessage(`Liquidación registrada: neto ${formatMoney(result.netAmount)}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo liquidar el período.");
    }
  }

  async function handleRemoveLiquidation(id: string) {
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

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">EMPLEADOS</p>
          <h1>Empleados y liquidación</h1>
          <p className="muted">Sueldo, premios, descuentos y vales — enlazado con las salidas de caja.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      <div className="content-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Empleados</h2>
            <span>{loading ? "Cargando…" : `${employees.length} activos`}</span>
          </div>
          <table className="data-table">
            <thead>
              <tr><th>Nombre</th><th className="num">Sueldo</th><th></th></tr>
            </thead>
            <tbody>
              {employees.map((employee) => (
                <tr key={employee.id}>
                  <td>{employee.fullName}</td>
                  <td className="num">{formatMoney(employee.baseSalary)} <span className="muted">{SALARY_PERIOD_LABELS[employee.salaryPeriod]}</span></td>
                  <td>
                    <button
                      className={employee.id === selectedId ? "" : "secondary"}
                      onClick={() => setSelectedId(employee.id)}
                    >
                      {employee.id === selectedId ? "Seleccionado" : "Ver"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {showNewForm ? (
            <div className="cash-banner-form" style={{ marginTop: 16, flexWrap: "wrap" }}>
              <input placeholder="Nombre" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <input type="text" inputMode="decimal" placeholder="Sueldo base" value={newSalary} onChange={(e) => setNewSalary(e.target.value)} />
              <select value={newSalaryPeriod} onChange={(e) => setNewSalaryPeriod(e.target.value as SalaryPeriod)}>
                <option value="monthly">Por mes</option>
                <option value="weekly">Por semana</option>
              </select>
              <button onClick={handleCreate}>Guardar empleado</button>
              <button className="secondary" onClick={() => setShowNewForm(false)}>Cancelar</button>
            </div>
          ) : (
            <button className="secondary" style={{ marginTop: 16 }} onClick={() => setShowNewForm(true)}>
              + Agregar empleado
            </button>
          )}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Datos del empleado</h2>
          </div>
          {!selectedEmployee && <p className="muted">Elegí un empleado para ver el detalle.</p>}
          {selectedEmployee && !editingEmployee && (
            <div className="totals">
              <span>Nombre <b>{selectedEmployee.fullName}</b></span>
              <span>Sueldo base <b>{formatMoney(selectedEmployee.baseSalary)} {SALARY_PERIOD_LABELS[selectedEmployee.salaryPeriod]}</b></span>
              <span>Estado <b>{selectedEmployee.active ? "Activo" : "Inactivo"}</b></span>
              <button className="secondary" style={{ marginTop: 10 }} onClick={() => setEditingEmployee(true)}>Editar</button>
            </div>
          )}
          {selectedEmployee && editingEmployee && (
            <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} />
              <input type="text" inputMode="decimal" value={editSalary} onChange={(e) => setEditSalary(e.target.value)} />
              <select value={editSalaryPeriod} onChange={(e) => setEditSalaryPeriod(e.target.value as SalaryPeriod)}>
                <option value="monthly">Por mes</option>
                <option value="weekly">Por semana</option>
              </select>
              <select value={editActive ? "1" : "0"} onChange={(e) => setEditActive(e.target.value === "1")}>
                <option value="1">Activo</option>
                <option value="0">Inactivo (eliminado)</option>
              </select>
              <button onClick={handleUpdate}>Guardar</button>
              <button className="secondary" onClick={() => setEditingEmployee(false)}>Cancelar</button>
            </div>
          )}
        </section>
      </div>

      {selectedEmployee && (
        <>
          <div className="content-grid" style={{ marginTop: 18 }}>
            <section className="panel no-print">
              <div className="panel-title">
                <h2>Premios y descuentos</h2>
                <span>{detailLoading ? "Cargando…" : null}</span>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
                <input type="date" value={adjDate} onChange={(e) => setAdjDate(e.target.value)} />
                <select value={adjType} onChange={(e) => setAdjType(e.target.value as PayrollAdjustmentType)}>
                  <option value="bonus">Premio</option>
                  <option value="deduction">Descuento</option>
                </select>
                <input type="text" inputMode="decimal" placeholder="Monto" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} />
                <input placeholder="Motivo" value={adjReason} onChange={(e) => setAdjReason(e.target.value)} />
                <button onClick={handleAddAdjustment}>Agregar</button>
              </div>
              <table className="data-table">
                <thead>
                  <tr><th>Fecha</th><th>Tipo</th><th>Motivo</th><th className="num">Monto</th><th></th></tr>
                </thead>
                <tbody>
                  {adjustments.map((a) => (
                    <tr key={a.id}>
                      <td>{a.adjustmentDate}</td>
                      <td>{ADJUSTMENT_TYPE_LABELS[a.type]}</td>
                      <td>{a.reason}</td>
                      <td className={`num ${a.type === "deduction" ? "num-negative" : "num-positive"}`}>{a.type === "deduction" ? "-" : "+"}{formatMoney(a.amount)}</td>
                      <td><button className="danger" onClick={() => handleRemoveAdjustment(a.id)}>Quitar</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {adjustments.length === 0 && <p className="muted">Todavía no hay premios ni descuentos cargados.</p>}
            </section>

            <section className="panel">
              <div className="panel-title">
                <h2>Vales retirados</h2>
              </div>
              <table className="data-table">
                <thead>
                  <tr><th>Fecha</th><th>Turno</th><th>Tipo</th><th>Detalle</th><th className="num">Monto</th><th>Estado</th></tr>
                </thead>
                <tbody>
                  {vouchers.map((v) => (
                    <tr key={v.id}>
                      <td>{v.shiftDate}</td>
                      <td>{v.shift === "morning" ? "Mañana" : "Tarde"}</td>
                      <td>{OUTFLOW_TYPE_LABELS[v.type] ?? v.type}</td>
                      <td>{v.detail}</td>
                      <td className="num">{formatMoney(v.amount)}</td>
                      <td>{v.liquidated ? "Liquidado" : "Pendiente"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {vouchers.length === 0 && <p className="muted">Todavía no retiró vales.</p>}
            </section>
          </div>

          <section className="panel print-area" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Liquidación</h2>
              <button className="secondary no-print" onClick={handlePrint}>Imprimir</button>
            </div>
            <p className="muted print-only-header">
              {selectedEmployee.fullName} · Sueldo {formatMoney(selectedEmployee.baseSalary)} {SALARY_PERIOD_LABELS[selectedEmployee.salaryPeriod]}
            </p>
            <div className="cash-banner-form no-print" style={{ flexWrap: "wrap", marginBottom: 14 }}>
              <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              <button className="secondary" onClick={() => { setPeriodStart(addDaysIso(todayIso(), -6)); setPeriodEnd(todayIso()); }}>Semana</button>
              <button className="secondary" onClick={() => { setPeriodStart(addDaysIso(todayIso(), -14)); setPeriodEnd(todayIso()); }}>Quincena</button>
              <button className="secondary" onClick={() => { setPeriodStart(addDaysIso(todayIso(), -29)); setPeriodEnd(todayIso()); }}>Mes</button>
            </div>

            <div className="kpi-grid">
              <div className="kpi-card">
                <span>Sueldo del período ({daysBetweenInclusive(periodStart, periodEnd)} días, {SALARY_PERIOD_LABELS[selectedEmployee.salaryPeriod]})</span>
                <strong>{formatMoney(previewBaseSalary)}</strong>
              </div>
              <div className="kpi-card">
                <span>Premios / descuentos</span>
                <strong>{formatMoney(periodAdjustmentsTotal)}</strong>
              </div>
              <div className="kpi-card">
                <span>Vales del período</span>
                <strong>{formatMoney(periodVouchersTotal)}</strong>
              </div>
              <div className="kpi-card">
                <span>Neto a pagar</span>
                <strong>{formatMoney(previewNet)}</strong>
              </div>
            </div>

            <div className="cash-banner-form no-print" style={{ flexWrap: "wrap", marginTop: 14 }}>
              <select value={liquidationAccountId} onChange={(e) => setLiquidationAccountId(e.target.value)}>
                <option value="">¿De qué cuenta sale el pago?</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <button className="charge-button" onClick={handleLiquidate}>
                Liquidar período
              </button>
            </div>

            <table className="data-table" style={{ marginTop: 18 }}>
              <thead>
                <tr><th>Período</th><th className="num">Sueldo</th><th className="num">Ajustes</th><th className="num">Vales</th><th className="num">Neto</th><th>Pagado desde</th><th className="no-print"></th></tr>
              </thead>
              <tbody>
                {liquidations.map((l) => (
                  <tr key={l.id}>
                    <td>{l.periodStart} — {l.periodEnd}</td>
                    <td className="num">{formatMoney(l.baseSalary)}</td>
                    <td className="num">{formatMoney(l.adjustmentsTotal)}</td>
                    <td className="num">{formatMoney(l.vouchersTotal)}</td>
                    <td className="num">{formatMoney(l.netAmount)}</td>
                    <td>{l.accountName ?? (l.netAmount <= 0 ? "—" : "sin registrar")}</td>
                    <td className="no-print"><button className="danger" onClick={() => handleRemoveLiquidation(l.id)}>Borrar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {liquidations.length === 0 && <p className="muted">Todavía no hay liquidaciones registradas.</p>}
          </section>
        </>
      )}
    </>
  );
}
