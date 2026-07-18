import { useEffect, useMemo, useState } from "react";
import type { ShiftOutflowType, ShiftPeriod } from "@patagonia/domain";
import { useSuppliers } from "../purchases/useSuppliers";
import { useEmployees } from "../employees/useEmployees";
import { useTreasury } from "./useTreasury";
import { useShifts } from "./useShifts";
import { formatMoney, todayIso } from "./format";
import { parseAmount } from "../../lib/money";

const OUTFLOW_TYPE_LABELS: Record<ShiftOutflowType, string> = {
  vale_mercaderia: "Vale · Mercadería",
  vale_adelanto: "Vale · Adelanto de sueldo",
  pago_proveedor: "Pago a proveedor",
  gasto: "Gasto"
};

export function Shifts() {
  const { accounts, loading: treasuryLoading, error: treasuryError } = useTreasury();
  const { suppliers } = useSuppliers();
  const { employees } = useEmployees();
  const {
    current: shift,
    sales,
    outflows,
    loading: shiftLoading,
    error: shiftError,
    load,
    save,
    saveSale,
    removeSale,
    saveOutflow,
    removeOutflow
  } = useShifts();

  const [shiftDate, setShiftDate] = useState(todayIso());
  const [shiftPeriod, setShiftPeriod] = useState<ShiftPeriod>("morning");
  const [openingCash, setOpeningCash] = useState("0");
  const [closingCountedCash, setClosingCountedCash] = useState("");
  const [message, setMessage] = useState("");

  const [saleAccountId, setSaleAccountId] = useState("");
  const [saleAmount, setSaleAmount] = useState("");
  const [editingSaleId, setEditingSaleId] = useState<string | null>(null);

  const [outflowType, setOutflowType] = useState<ShiftOutflowType>("gasto");
  const [outflowAccountId, setOutflowAccountId] = useState("");
  const [outflowAmount, setOutflowAmount] = useState("");
  const [outflowDetail, setOutflowDetail] = useState("");
  const [outflowSupplierId, setOutflowSupplierId] = useState("");
  const [outflowEmployeeId, setOutflowEmployeeId] = useState("");
  const [editingOutflowId, setEditingOutflowId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
    void load(shiftDate, shiftPeriod);
  }, [shiftDate, shiftPeriod, load]);

  useEffect(() => {
    setOpeningCash(shift ? String(shift.openingCash) : "0");
    setClosingCountedCash(shift?.closingCountedCash !== undefined ? String(shift.closingCountedCash) : "");
  }, [shift]);

  const cashAccount = useMemo(() => accounts.find((a) => a.paymentMethod === "cash"), [accounts]);

  const salesTotal = useMemo(() => sales.reduce((sum, s) => sum + s.amount, 0), [sales]);
  const outflowsTotal = useMemo(() => outflows.reduce((sum, o) => sum + o.amount, 0), [outflows]);
  const hasSavedData = salesTotal > 0 || outflowsTotal > 0;
  const showForm = expanded || !hasSavedData;

  const cashSales = cashAccount ? sales.filter((s) => s.accountId === cashAccount.id).reduce((sum, s) => sum + s.amount, 0) : 0;
  const cashOutflows = cashAccount
    ? outflows.filter((o) => o.accountId === cashAccount.id).reduce((sum, o) => sum + o.amount, 0)
    : 0;
  const expectedCash = (shift?.openingCash ?? 0) + cashSales - cashOutflows;
  const countedCash = closingCountedCash ? parseAmount(closingCountedCash) : 0;
  const difference = closingCountedCash !== "" ? countedCash - expectedCash : null;

  async function handleSaveShift() {
    try {
      const opening = parseAmount(openingCash);
      if (!Number.isFinite(opening) || opening < 0) throw new Error("El inicio de caja no puede ser negativo.");
      const closing = closingCountedCash !== "" ? parseAmount(closingCountedCash) : undefined;
      if (closing !== undefined && (!Number.isFinite(closing) || closing < 0)) {
        throw new Error("El efectivo contado no puede ser negativo.");
      }
      await save(shiftDate, shiftPeriod, opening, closing);
      setExpanded(true);
      setMessage("Turno guardado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar el turno.");
    }
  }

  async function handleSaveSale() {
    try {
      if (!shift) throw new Error("Guardá el turno primero.");
      if (!saleAccountId) throw new Error("Elegí una cuenta.");
      const amount = parseAmount(saleAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");

      await saveSale(
        { id: editingSaleId ?? undefined, shiftId: shift.id, accountId: saleAccountId, amount },
        shiftDate,
        shiftPeriod
      );
      setSaleAmount("");
      setEditingSaleId(null);
      setExpanded(true);
      setMessage("Venta guardada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar la venta.");
    }
  }

  async function handleRemoveSale(saleId: string) {
    try {
      if (!shift) return;
      await removeSale(saleId, shift.id, shiftDate, shiftPeriod);
      setMessage("Venta eliminada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo eliminar la venta.");
    }
  }

  async function handleSaveOutflow() {
    try {
      if (!shift) throw new Error("Guardá el turno primero.");
      if (!outflowAccountId) throw new Error("Elegí una cuenta.");
      const amount = parseAmount(outflowAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!outflowDetail.trim()) throw new Error("Ingresá un detalle.");

      await saveOutflow(
        {
          id: editingOutflowId ?? undefined,
          shiftId: shift.id,
          accountId: outflowAccountId,
          type: outflowType,
          amount,
          detail: outflowDetail.trim(),
          supplierId: outflowType === "pago_proveedor" ? outflowSupplierId || undefined : undefined,
          employeeId: outflowType === "vale_mercaderia" || outflowType === "vale_adelanto" ? outflowEmployeeId || undefined : undefined
        },
        shiftDate,
        shiftPeriod
      );
      setOutflowAmount("");
      setOutflowDetail("");
      setOutflowSupplierId("");
      setOutflowEmployeeId("");
      setEditingOutflowId(null);
      setExpanded(true);
      setMessage("Salida guardada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo guardar la salida.");
    }
  }

  async function handleRemoveOutflow(outflowId: string) {
    try {
      if (!shift) return;
      await removeOutflow(outflowId, shift.id, shiftDate, shiftPeriod);
      setMessage("Salida eliminada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo eliminar la salida.");
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">VENTAS</p>
          <h1>Ventas y caja</h1>
          <p className="muted">Fecha, turno mañana/tarde, ventas por medio de pago y salidas — editable siempre.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {treasuryError && <div className="message warning">{treasuryError}</div>}
      {shiftError && <div className="message warning">{shiftError}</div>}

      <section className="panel shift-card">
        <div className="shift-toolbar">
          <div className="field">
            <span>Fecha</span>
            <input type="date" value={shiftDate} onChange={(e) => setShiftDate(e.target.value)} />
          </div>
          <div className="period-toggle">
            <button className={shiftPeriod === "morning" ? "active" : ""} onClick={() => setShiftPeriod("morning")}>Mañana</button>
            <button className={shiftPeriod === "afternoon" ? "active" : ""} onClick={() => setShiftPeriod("afternoon")}>Tarde</button>
          </div>
          <span className={shift ? "status-pill" : "muted"}>{shiftLoading || treasuryLoading ? "Cargando…" : shift ? "Turno guardado" : "Turno sin guardar"}</span>
        </div>
        <div className="shift-toolbar" style={{ borderBottom: "none", marginBottom: 0, paddingBottom: 0 }}>
          <div className="field">
            <span>Inicio de caja</span>
            <input type="text" inputMode="decimal" value={openingCash} onChange={(e) => setOpeningCash(e.target.value)} />
          </div>
          <button onClick={handleSaveShift}>Guardar turno</button>
        </div>
      </section>

      {shift && !showForm && (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Turno cargado</h2>
            <button className="secondary" onClick={() => setExpanded(true)}>Ver / Editar</button>
          </div>
          <div className="totals">
            <span>Ventas totales <b>{formatMoney(salesTotal)}</b></span>
            <span>Salidas totales <b>{formatMoney(outflowsTotal)}</b></span>
          </div>
        </section>
      )}

      {shift && showForm && (
        <>
          {hasSavedData && (
            <div className="panel-title" style={{ marginTop: 18, marginBottom: -6 }}>
              <span />
              <button className="secondary" onClick={() => setExpanded(false)}>Ocultar</button>
            </div>
          )}
          <div className="content-grid" style={{ marginTop: 18 }}>
            <section className="panel">
              <div className="panel-title">
                <h2>Ventas del turno</h2>
                <span>{formatMoney(salesTotal)}</span>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
                <select value={saleAccountId} onChange={(e) => setSaleAccountId(e.target.value)}>
                  <option value="">Cuenta…</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.name}</option>
                  ))}
                </select>
                <input type="text" inputMode="decimal" placeholder="Monto" value={saleAmount} onChange={(e) => setSaleAmount(e.target.value)} />
                <button onClick={handleSaveSale}>{editingSaleId ? "Guardar cambio" : "Agregar venta"}</button>
              </div>

              <table className="data-table">
                <thead>
                  <tr><th>Cuenta</th><th className="num">Monto</th><th></th></tr>
                </thead>
                <tbody>
                  {sales.map((sale) => (
                    <tr key={sale.id}>
                      <td>{accounts.find((a) => a.id === sale.accountId)?.name ?? "-"}</td>
                      <td className="num">{formatMoney(sale.amount)}</td>
                      <td>
                        <button
                          className="secondary"
                          onClick={() => {
                            setEditingSaleId(sale.id);
                            setSaleAccountId(sale.accountId);
                            setSaleAmount(String(sale.amount));
                          }}
                        >
                          Editar
                        </button>
                        <button className="danger" onClick={() => handleRemoveSale(sale.id)}>Quitar</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sales.length === 0 && <p className="muted">Todavía no hay ventas cargadas.</p>}
            </section>

            <section className="panel">
              <div className="panel-title">
                <h2>Salidas del turno</h2>
                <span>{formatMoney(outflowsTotal)}</span>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
                <select value={outflowType} onChange={(e) => setOutflowType(e.target.value as ShiftOutflowType)}>
                  {Object.entries(OUTFLOW_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <select value={outflowAccountId} onChange={(e) => setOutflowAccountId(e.target.value)}>
                  <option value="">Cuenta…</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.name}</option>
                  ))}
                </select>
                {outflowType === "pago_proveedor" && (
                  <select value={outflowSupplierId} onChange={(e) => setOutflowSupplierId(e.target.value)}>
                    <option value="">Proveedor…</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                )}
                {(outflowType === "vale_mercaderia" || outflowType === "vale_adelanto") && (
                  <select value={outflowEmployeeId} onChange={(e) => setOutflowEmployeeId(e.target.value)}>
                    <option value="">Empleado…</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>{emp.fullName}</option>
                    ))}
                  </select>
                )}
                <input type="text" inputMode="decimal" placeholder="Monto" value={outflowAmount} onChange={(e) => setOutflowAmount(e.target.value)} />
                <input placeholder="Detalle" value={outflowDetail} onChange={(e) => setOutflowDetail(e.target.value)} />
                <button onClick={handleSaveOutflow}>{editingOutflowId ? "Guardar cambio" : "Agregar salida"}</button>
              </div>

              <table className="data-table">
                <thead>
                  <tr><th>Tipo</th><th>Cuenta</th><th>Detalle</th><th className="num">Monto</th><th></th></tr>
                </thead>
                <tbody>
                  {outflows.map((outflow) => (
                    <tr key={outflow.id}>
                      <td>{OUTFLOW_TYPE_LABELS[outflow.type]}</td>
                      <td>{accounts.find((a) => a.id === outflow.accountId)?.name ?? "-"}</td>
                      <td>{outflow.detail}</td>
                      <td className="num">{formatMoney(outflow.amount)}</td>
                      <td>
                        <button
                          className="secondary"
                          onClick={() => {
                            setEditingOutflowId(outflow.id);
                            setOutflowType(outflow.type);
                            setOutflowAccountId(outflow.accountId);
                            setOutflowAmount(String(outflow.amount));
                            setOutflowDetail(outflow.detail);
                            setOutflowSupplierId(outflow.supplierId ?? "");
                            setOutflowEmployeeId(outflow.employeeId ?? "");
                          }}
                        >
                          Editar
                        </button>
                        <button className="danger" onClick={() => handleRemoveOutflow(outflow.id)}>Quitar</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {outflows.length === 0 && <p className="muted">Todavía no hay salidas cargadas.</p>}
            </section>
          </div>

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Resumen del turno</h2>
            </div>
            <div className="kpi-grid">
              <div className="kpi-card">
                <span>Inicio de caja</span>
                <strong>{formatMoney(shift.openingCash)}</strong>
              </div>
              <div className="kpi-card">
                <span>Ventas totales</span>
                <strong>{formatMoney(salesTotal)}</strong>
              </div>
              <div className="kpi-card">
                <span>Salidas totales</span>
                <strong>{formatMoney(outflowsTotal)}</strong>
              </div>
              {cashAccount && (
                <div className="kpi-card">
                  <span>Efectivo esperado</span>
                  <strong>{formatMoney(expectedCash)}</strong>
                </div>
              )}
            </div>
            {cashAccount && (
              <div className="shift-toolbar" style={{ borderBottom: "none", marginTop: 8, paddingBottom: 0 }}>
                <div className="field">
                  <span>Efectivo contado</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={closingCountedCash}
                    onChange={(e) => setClosingCountedCash(e.target.value)}
                  />
                </div>
                <button onClick={handleSaveShift}>Guardar cierre</button>
              </div>
            )}
            {difference !== null && (
              <p className={difference < 0 ? "message warning" : "message"} style={{ marginTop: 12 }}>
                Diferencia: {formatMoney(difference)}
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}
