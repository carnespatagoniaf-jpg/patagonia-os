import { useEffect, useMemo, useState } from "react";
import type { PaymentMethod } from "@patagonia/domain";
import { useTreasury } from "./useTreasury";
import { useShifts } from "./useShifts";
import { useActiveBranch } from "../branches/BranchProvider";
import { useAuth } from "../auth/AuthProvider";
import { planAllows } from "../auth/permissions";
import { addDaysIso, formatMoney, todayIso } from "./format";
import { parseAmount } from "../../lib/money";
import type { ShiftRangeRow } from "./shifts-service";
import { listTreasuryMovements, type TreasuryExpenseCategory, type TreasuryMovementRow } from "./treasury-service";

// Al sistema solo le importa si la cuenta es efectivo o no (cierre de caja,
// vuelto, cupón obligatorio) -- un posnet recibe débito, crédito y QR juntos,
// así que no tiene sentido pedir el tipo exacto. Obligatorio para que una
// cuenta de efectivo nunca quede sin marcar.
const PAYMENT_METHOD_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Efectivo" },
  { value: "digital", label: "Pagos digitales (posnet, banco, transferencia, QR)" }
];

const MOVEMENTS_SEARCH_LIMIT = 3000;

export const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  venta: "Venta",
  ajuste: "Ajuste",
  transferencia: "Transferencia",
  pago_proveedor: "Pago a proveedor",
  pago_acreedor: "Pago a acreedor",
  creditor_debt: "Préstamo recibido",
  vale_mercaderia: "Vale · Mercadería",
  vale_adelanto: "Vale · Adelanto de sueldo",
  gasto: "Gasto",
  sueldo: "Liquidación de sueldo"
};

const EXPENSE_CATEGORY_OPTIONS: { value: TreasuryExpenseCategory; label: string }[] = [
  { value: "mantenimiento", label: "Mantenimiento / reparaciones" },
  { value: "servicios", label: "Servicios (luz, gas, alquiler)" },
  { value: "impuestos", label: "Impuestos" },
  { value: "insumos", label: "Insumos varios" },
  { value: "otro", label: "Otro" }
];

const EXPENSE_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  EXPENSE_CATEGORY_OPTIONS.map((o) => [o.value, o.label])
);

/** Color de la etiqueta de cada tipo de movimiento (rediseño 2026-11-02). */
const MOVEMENT_BADGE: Record<string, string> = {
  venta: "ok",
  pago_proveedor: "danger",
  pago_acreedor: "danger",
  transferencia: "info",
  vale_mercaderia: "warn",
  vale_adelanto: "warn",
  sueldo: "warn",
  creditor_debt: "info"
};

/** "2026-10-31" → "31/10". */
function shortDate(iso: string) {
  const [, m, d] = iso.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : iso;
}

export function Treasury() {
  const { accounts, allAccounts, balances, movements, loading, error, create, adjust, transfer, registerExpense, removeExpense, setActive, setAccountBranch } = useTreasury();
  const { loadRange } = useShifts();
  const { branches: allBranches } = useActiveBranch();
  const { profile } = useAuth();
  // Separar cuentas por sucursal es del plan Full: con otro plan se trabaja
  // como si hubiera una sola (todas las cuentas compartidas).
  const branches = planAllows(profile, "full") ? allBranches : allBranches.slice(0, 1);

  const [message, setMessage] = useState("");
  // Rediseño 2026-11-02: un solo lugar para cargar (gasto / pase / ajuste) y la administración de cuentas plegada.
  const [action, setAction] = useState<"expense" | "transfer" | "adjust">("expense");
  const [showManage, setShowManage] = useState(false);

  const [salesFrom, setSalesFrom] = useState(addDaysIso(todayIso(), -29));
  const [salesTo, setSalesTo] = useState(todayIso());
  const [salesRows, setSalesRows] = useState<ShiftRangeRow[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesRanOnce, setSalesRanOnce] = useState(false);

  async function runSalesByDate(nextFrom: string, nextTo: string) {
    setSalesFrom(nextFrom);
    setSalesTo(nextTo);
    setSalesLoading(true);
    try {
      setSalesRows(await loadRange(nextFrom, nextTo));
      setSalesRanOnce(true);
    } finally {
      setSalesLoading(false);
    }
  }

  const salesByDay = useMemo(() => {
    const dates = Array.from(new Set(salesRows.map((row) => row.shift.shiftDate))).sort();
    return dates.map((date) => {
      const dayRows = salesRows.filter((row) => row.shift.shiftDate === date);
      const perAccount = accounts.map((account) => ({
        accountId: account.id,
        amount: dayRows.reduce(
          (sum, row) => sum + row.sales.filter((s) => s.accountId === account.id).reduce((s, r) => s + r.amount, 0),
          0
        )
      }));
      const total = perAccount.reduce((sum, a) => sum + a.amount, 0);
      return { date, perAccount, total };
    });
  }, [salesRows, accounts]);
  // Arranca mostrando las ventas de los últimos 7 días (antes había que tocar Buscar).
  useEffect(() => {
    void runSalesByDate(addDaysIso(todayIso(), -6), todayIso());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [showNewAccountForm, setShowNewAccountForm] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [accountPaymentMethod, setAccountPaymentMethod] = useState<PaymentMethod | "">("");
  const [accountInitialBalance, setAccountInitialBalance] = useState("");
  const [accountBranchId, setAccountBranchId] = useState("");
  const [branchBusyId, setBranchBusyId] = useState("");

  const [adjustAccountId, setAdjustAccountId] = useState("");
  const [adjustDirection, setAdjustDirection] = useState<"in" | "out">("out");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const [transferFromId, setTransferFromId] = useState("");
  const [transferToId, setTransferToId] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferReason, setTransferReason] = useState("");

  const [expenseDate, setExpenseDate] = useState(todayIso());
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [expenseCategory, setExpenseCategory] = useState<TreasuryExpenseCategory>("mantenimiento");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseDescription, setExpenseDescription] = useState("");

  const [movementsFrom, setMovementsFrom] = useState(addDaysIso(todayIso(), -29));
  const [movementsTo, setMovementsTo] = useState(todayIso());
  const [movementsAccountId, setMovementsAccountId] = useState("");
  const [movementsRows, setMovementsRows] = useState<TreasuryMovementRow[] | null>(null);
  const [movementsLoading, setMovementsLoading] = useState(false);
  const displayedMovements = movementsRows ?? movements;

  async function handleCreateAccount() {
    try {
      if (!accountName.trim()) throw new Error("El nombre de la cuenta es obligatorio.");
      const initialBalance = accountInitialBalance ? parseAmount(accountInitialBalance) : 0;
      if (!Number.isFinite(initialBalance) || initialBalance < 0) throw new Error("El saldo inicial no puede ser negativo.");
      if (!accountPaymentMethod) throw new Error("Elegí si la cuenta es Efectivo o Pagos digitales.");
      await create({ name: accountName.trim(), paymentMethod: accountPaymentMethod, initialBalance, branchId: accountBranchId || undefined });
      setAccountName("");
      setAccountPaymentMethod("");
      setAccountInitialBalance("");
      setAccountBranchId("");
      setShowNewAccountForm(false);
      setMessage("Cuenta creada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear la cuenta.");
    }
  }

  async function handleChangeAccountBranch(accountId: string, newBranchId: string) {
    setBranchBusyId(accountId);
    try {
      await setAccountBranch(accountId, newBranchId || null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cambiar la sucursal de la cuenta.");
    } finally {
      setBranchBusyId("");
    }
  }

  async function handleAdjust() {
    try {
      if (!adjustAccountId) throw new Error("Elegí una cuenta.");
      const amount = parseAmount(adjustAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!adjustReason.trim()) throw new Error("Ingresá un motivo (ej. comisión, diferencia de caja).");
      await adjust({ accountId: adjustAccountId, amount, direction: adjustDirection, reason: adjustReason.trim() });
      setAdjustAmount("");
      setAdjustReason("");
      setMessage("Ajuste registrado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar el ajuste.");
    }
  }

  async function handleTransfer() {
    try {
      if (!transferFromId || !transferToId) throw new Error("Elegí cuenta de origen y destino.");
      const amount = parseAmount(transferAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      await transfer({ fromAccountId: transferFromId, toAccountId: transferToId, amount, reason: transferReason.trim() || undefined });
      setTransferAmount("");
      setTransferReason("");
      setMessage("Transferencia registrada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar la transferencia.");
    }
  }

  async function handleRegisterExpense() {
    try {
      if (!expenseAccountId) throw new Error("Elegí de qué cuenta sale el gasto.");
      const amount = parseAmount(expenseAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!expenseDescription.trim()) throw new Error("Ingresá una descripción (ej. arreglo de motor).");
      await registerExpense({
        accountId: expenseAccountId,
        amount,
        category: expenseCategory,
        description: expenseDescription.trim(),
        expenseDate
      });
      setExpenseAmount("");
      setExpenseDescription("");
      setMessage("Gasto registrado.");
      setMovementsRows(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar el gasto.");
    }
  }

  async function handleRemoveExpense(id: string) {
    if (!window.confirm("¿Seguro que querés borrar este gasto? No se puede deshacer.")) return;
    try {
      await removeExpense(id);
      setMessage("Gasto eliminado.");
      setMovementsRows(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo eliminar el gasto.");
    }
  }

  async function handleToggleActive(accountId: string, active: boolean) {
    try {
      await setActive(accountId, active);
      setMessage(active ? "Cuenta reactivada." : "Cuenta desactivada — sigue en el historial, pero ya no aparece para cobrar, ajustar ni transferir.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cambiar el estado de la cuenta.");
    }
  }

  async function handleSearchMovements() {
    setMovementsLoading(true);
    try {
      setMovementsRows(
        await listTreasuryMovements({
          from: movementsFrom,
          to: movementsTo,
          accountId: movementsAccountId || undefined,
          limit: MOVEMENTS_SEARCH_LIMIT
        })
      );
    } finally {
      setMovementsLoading(false);
    }
  }

  const activeBalanceTotal = balances.reduce((sum, b) => ((allAccounts.find((a) => a.id === b.accountId)?.active ?? true) ? sum + b.balance : sum), 0);
  const movementsIn = displayedMovements.reduce((sum, m) => (m.direction === "in" ? sum + m.amount : sum), 0);
  const movementsOut = displayedMovements.reduce((sum, m) => (m.direction === "out" ? sum + m.amount : sum), 0);
  const salesMax = Math.max(1, ...salesByDay.map((d) => d.total));
  const salesTotal = salesByDay.reduce((sum, d) => sum + d.total, 0);
  const salesPreset = salesTo === todayIso() ? (salesFrom === todayIso() ? "today" : salesFrom === addDaysIso(todayIso(), -6) ? "week" : salesFrom === addDaysIso(todayIso(), -29) ? "month" : null) : null;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">TESORERÍA</p>
          <h1>Tesorería</h1>
          <p className="muted">Cuánta plata hay en cada cuenta, gastos, pases entre cuentas y ajustes.</p>
        </div>
        <button className="secondary" onClick={() => setShowManage((v) => !v)}>{showManage ? "Listo" : "Administrar cuentas"}</button>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      <div className="ws-cards">
        <div className="ws-card total">
          <span>Total disponible</span>
          <strong>{formatMoney(activeBalanceTotal)}</strong>
          <small>{loading ? "Cargando…" : `${accounts.length} ${accounts.length === 1 ? "cuenta activa" : "cuentas activas"}`}</small>
        </div>
        {balances.map((balance) => {
          const account = allAccounts.find((a) => a.id === balance.accountId);
          const isActive = account?.active ?? true;
          const branchName = account?.branchId ? branches.find((b) => b.id === account.branchId)?.name : null;
          return (
            <div className={isActive ? "ws-card" : "ws-card inactive"} key={balance.accountId}>
              <span title={balance.name}>{balance.name}</span>
              <strong className={balance.balance < 0 ? "num-negative" : ""}>{formatMoney(balance.balance)}</strong>
              <small>
                {account?.paymentMethod === "cash" ? "Efectivo" : "Digital"}
                {branchName ? ` · Solo ${branchName}` : ""}
                {!isActive ? " · Inactiva" : ""}
              </small>
            </div>
          );
        })}
      </div>

      {showManage && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-title">
            <h2>Administrar cuentas</h2>
            {!showNewAccountForm && <button className="secondary" onClick={() => setShowNewAccountForm(true)}>+ Agregar cuenta</button>}
          </div>
          {showNewAccountForm && (
            <div className="form-box" style={{ marginBottom: 12 }}>
              <div className="form-grid">
                <label>Nombre de cuenta<input placeholder="Ej. Banco Galicia" value={accountName} onChange={(e) => setAccountName(e.target.value)} /></label>
                <label>
                  Tipo de cuenta
                  <select value={accountPaymentMethod} onChange={(e) => setAccountPaymentMethod(e.target.value as PaymentMethod | "")}>
                    <option value="">Elegí un tipo…</option>
                    {PAYMENT_METHOD_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>Saldo inicial<input type="text" inputMode="decimal" placeholder="$ 0" value={accountInitialBalance} onChange={(e) => setAccountInitialBalance(e.target.value)} /></label>
                {branches.length > 1 && (
                  <label>
                    Sucursal
                    <select value={accountBranchId} onChange={(e) => setAccountBranchId(e.target.value)}>
                      <option value="">Compartida (todas las sucursales)</option>
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>Solo {b.name}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <div className="form-actions">
                <button onClick={handleCreateAccount}>Guardar cuenta</button>
                <button className="secondary" onClick={() => setShowNewAccountForm(false)}>Cancelar</button>
              </div>
            </div>
          )}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Cuenta</th><th className="num">Saldo</th>{branches.length > 1 && <th>Sucursal</th>}<th>Estado</th><th></th></tr>
              </thead>
              <tbody>
                {balances.map((balance) => {
                  const account = allAccounts.find((a) => a.id === balance.accountId);
                  if (!account) return null;
                  return (
                    <tr key={balance.accountId}>
                      <td>{balance.name}</td>
                      <td className="num">{formatMoney(balance.balance)}</td>
                      {branches.length > 1 && (
                        <td>
                          <select value={account.branchId ?? ""} disabled={branchBusyId === account.id} onChange={(e) => void handleChangeAccountBranch(account.id, e.target.value)}>
                            <option value="">Compartida (todas)</option>
                            {branches.map((b) => (
                              <option key={b.id} value={b.id}>Solo {b.name}</option>
                            ))}
                          </select>
                        </td>
                      )}
                      <td>{account.active ? <span className="badge ok">Activa</span> : <span className="badge">Inactiva</span>}</td>
                      <td><button className="secondary" onClick={() => handleToggleActive(account.id, !account.active)}>{account.active ? "Desactivar" : "Activar"}</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
            Las cuentas no se pueden borrar (los movimientos históricos quedarían sin cuenta): se desactivan y dejan de aparecer para cobrar, ajustar o transferir, pero el historial y los saldos viejos quedan.
            {branches.length > 1 && " Una cuenta \"Compartida\" la usa cualquier sucursal; una de una sola sucursal solo aparece para cobrar en esa sucursal."}
          </p>
        </section>
      )}

      <div className="ws-cols">
        <section className="panel">
          <div className="panel-title" style={{ marginBottom: 0 }}>
            <h2>Cargar un movimiento</h2>
          </div>
          <div className="ws-seg">
            <button className={action === "expense" ? "active" : ""} onClick={() => setAction("expense")}>Gasto</button>
            <button className={action === "transfer" ? "active" : ""} onClick={() => setAction("transfer")}>Pasar de una cuenta a otra</button>
            <button className={action === "adjust" ? "active" : ""} onClick={() => setAction("adjust")}>Ajuste</button>
          </div>

          {action === "expense" && (
            <div className="ws-form">
              <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>Plata que sale de verdad (arreglos, servicios, impuestos), sin necesidad de un turno abierto.</p>
              <div className="ws-form-row">
                <label className="ws-field">
                  ¿En qué?
                  <select value={expenseCategory} onChange={(e) => setExpenseCategory(e.target.value as TreasuryExpenseCategory)}>
                    {EXPENSE_CATEGORY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="ws-field">Monto<input type="text" inputMode="decimal" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} style={{ width: 140 }} /></label>
                <label className="ws-field">
                  Sale de
                  <select value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)}>
                    <option value="">Elegí la cuenta…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="ws-form-row" style={{ marginTop: 10 }}>
                <label className="ws-field ws-grow">Descripción<input placeholder="Ej. arreglo de motor" value={expenseDescription} onChange={(e) => setExpenseDescription(e.target.value)} /></label>
                <label className="ws-field">Fecha<input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} /></label>
                <button onClick={handleRegisterExpense}>Registrar gasto</button>
              </div>
            </div>
          )}

          {action === "transfer" && (
            <div className="ws-form">
              <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>Ej.: pasar de Mercado Pago al Banco, o llevar el efectivo al banco.</p>
              <div className="ws-form-row">
                <label className="ws-field">
                  Desde
                  <select value={transferFromId} onChange={(e) => setTransferFromId(e.target.value)}>
                    <option value="">Elegí…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>
                <label className="ws-field">
                  Hacia
                  <select value={transferToId} onChange={(e) => setTransferToId(e.target.value)}>
                    <option value="">Elegí…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>
                <label className="ws-field">Monto<input type="text" inputMode="decimal" value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)} style={{ width: 140 }} /></label>
              </div>
              <div className="ws-form-row" style={{ marginTop: 10 }}>
                <label className="ws-field ws-grow">Nota (opcional)<input value={transferReason} onChange={(e) => setTransferReason(e.target.value)} /></label>
                <button onClick={handleTransfer}>Pasar la plata</button>
              </div>
            </div>
          )}

          {action === "adjust" && (
            <div className="ws-form">
              <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>Solo para corregir diferencias (comisiones, errores de conteo). Para gastos reales usá "Gasto".</p>
              <div className="ws-form-row">
                <label className="ws-field">
                  Cuenta
                  <select value={adjustAccountId} onChange={(e) => setAdjustAccountId(e.target.value)}>
                    <option value="">Elegí…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>
                <label className="ws-field">
                  ¿Suma o resta?
                  <select value={adjustDirection} onChange={(e) => setAdjustDirection(e.target.value as "in" | "out")}>
                    <option value="out">Restar</option>
                    <option value="in">Sumar</option>
                  </select>
                </label>
                <label className="ws-field">Monto<input type="text" inputMode="decimal" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} style={{ width: 140 }} /></label>
              </div>
              <div className="ws-form-row" style={{ marginTop: 10 }}>
                <label className="ws-field ws-grow">Motivo<input placeholder="Ej. comisión Mercado Pago" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} /></label>
                <button onClick={handleAdjust}>Registrar ajuste</button>
              </div>
            </div>
          )}

          <div className="ws-box">
            <h3>
              {movementsRows === null ? "Últimos movimientos" : "Movimientos encontrados"}
              <span className="ws-form-row" style={{ gap: 6 }}>
                <input type="date" value={movementsFrom} onChange={(e) => setMovementsFrom(e.target.value)} />
                <input type="date" value={movementsTo} onChange={(e) => setMovementsTo(e.target.value)} />
                <select value={movementsAccountId} onChange={(e) => setMovementsAccountId(e.target.value)}>
                  <option value="">Todas las cuentas</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <button className="secondary" onClick={handleSearchMovements}>Buscar</button>
                {movementsRows !== null && <button className="secondary" onClick={() => setMovementsRows(null)}>Ver últimos 30</button>}
              </span>
            </h3>
            {movementsLoading ? (
              <p className="muted ws-empty">Buscando…</p>
            ) : (
              <div className="ws-scroll">
                <table className="data-table">
                  <thead>
                    <tr><th>Fecha</th><th>Qué</th><th className="hide-sm">Cuenta</th><th className="num">Entra</th><th className="num">Sale</th><th></th></tr>
                  </thead>
                  <tbody>
                    {displayedMovements.map((m) => (
                      <tr key={m.id}>
                        <td className="ws-date">{shortDate(m.occurredOn)}</td>
                        <td className="ws-concept">
                          <span className={`badge ${MOVEMENT_BADGE[m.movementType] ?? ""}`}>{MOVEMENT_TYPE_LABELS[m.movementType] ?? m.movementType}</span>{" "}
                          {m.category ? `${EXPENSE_CATEGORY_LABELS[m.category] ?? m.category}` : ""}
                          {m.notes && <small>{m.notes}</small>}
                        </td>
                        <td className="hide-sm">{m.accountName}</td>
                        <td className="num num-positive">{m.direction === "in" ? formatMoney(m.amount) : ""}</td>
                        <td className="num num-negative">{m.direction === "out" ? formatMoney(m.amount) : ""}</td>
                        <td>
                          {m.movementType === "gasto" && (
                            <div className="ws-row-actions"><button className="danger" onClick={() => handleRemoveExpense(m.id)}>Borrar</button></div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {displayedMovements.length === 0 && <p className="muted ws-empty">No hay movimientos para mostrar.</p>}
              </div>
            )}
            {!movementsLoading && displayedMovements.length > 0 && (
              <div className="ws-box-foot">
                <span>{displayedMovements.length} movimientos</span>
                <span><span className="num-positive">+ {formatMoney(movementsIn)}</span> &nbsp; <span className="num-negative">− {formatMoney(movementsOut)}</span></span>
              </div>
            )}
          </div>
          {!movementsLoading && movementsRows !== null && movementsRows.length === MOVEMENTS_SEARCH_LIMIT && (
            <p className="message warning" style={{ marginTop: 10 }}>
              Hay {MOVEMENTS_SEARCH_LIMIT} o más movimientos en ese rango: puede que falten los más viejos. Achicá el rango de fechas o filtrá por cuenta.
            </p>
          )}
        </section>

        <section className="panel">
          <div className="panel-title" style={{ marginBottom: 8 }}>
            <h2>Ventas por fecha</h2>
          </div>
          <div className="ws-chips">
            <button className={salesPreset === "today" ? "ws-chip active" : "ws-chip"} onClick={() => runSalesByDate(todayIso(), todayIso())}>Hoy</button>
            <button className={salesPreset === "week" ? "ws-chip active" : "ws-chip"} onClick={() => runSalesByDate(addDaysIso(todayIso(), -6), todayIso())}>7 días</button>
            <button className={salesPreset === "month" ? "ws-chip active" : "ws-chip"} onClick={() => runSalesByDate(addDaysIso(todayIso(), -29), todayIso())}>30 días</button>
          </div>
          <div className="ws-form-row" style={{ gap: 6, marginBottom: 10 }}>
            <input type="date" value={salesFrom} onChange={(e) => setSalesFrom(e.target.value)} />
            <input type="date" value={salesTo} onChange={(e) => setSalesTo(e.target.value)} />
            <button className="secondary" onClick={() => runSalesByDate(salesFrom, salesTo)}>Buscar</button>
          </div>
          {salesLoading ? (
            <p className="muted">Cargando…</p>
          ) : salesByDay.length === 0 ? (
            <p className="muted">{salesRanOnce ? "No hay ventas cargadas en esas fechas." : "Elegí un período."}</p>
          ) : (
            <>
              <div className="ws-scroll">
                <table className="data-table no-stack ws-bars">
                  <tbody>
                    {[...salesByDay].reverse().map((day) => (
                      <tr key={day.date}>
                        <td className="ws-date">{shortDate(day.date)}</td>
                        <td style={{ width: "55%" }}><div className="ws-bar"><i style={{ width: `${Math.round((day.total / salesMax) * 100)}%` }} /></div></td>
                        <td className="num">{formatMoney(day.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="ws-box-foot" style={{ borderTop: "1px solid var(--line)" }}>
                <span>Total</span>
                <span>{formatMoney(salesTotal)}</span>
              </div>
              <table className="data-table no-stack" style={{ marginTop: 8 }}>
                <tbody>
                  {accounts.map((account) => {
                    const total = salesByDay.reduce((sum, d) => sum + (d.perAccount.find((a) => a.accountId === account.id)?.amount ?? 0), 0);
                    return total > 0 ? (
                      <tr key={account.id}>
                        <td>{account.name}</td>
                        <td className="num">{formatMoney(total)}</td>
                        <td className="num muted">{salesTotal > 0 ? `${Math.round((total / salesTotal) * 100)}%` : ""}</td>
                      </tr>
                    ) : null;
                  })}
                </tbody>
              </table>
            </>
          )}
        </section>
      </div>
    </>
  );
}
