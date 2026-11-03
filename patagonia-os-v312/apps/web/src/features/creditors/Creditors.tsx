import { Fragment, useEffect, useMemo, useState } from "react";
import { isOverdueDebt } from "@patagonia/domain";
import { useCreditors } from "./useCreditors";
import { useTreasury } from "../shifts/useTreasury";
import { addDaysIso, todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

/** "2026-10-31" → "31/10". */
function shortDate(iso: string) {
  const [, m, d] = iso.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : iso;
}

interface LedgerRow {
  key: string;
  type: "debt" | "payment";
  id: string;
  date: string;
  detail: string;
  debit: number;
  credit: number;
  balance: number;
}

export function Creditors() {
  const {
    creditors,
    loading,
    error,
    create,
    update,
    debts,
    payments,
    balance,
    detailLoading,
    loadDetail,
    addDebt,
    registerPayment,
    editDebt,
    removeDebt,
    editPayment,
    removePayment
  } = useCreditors();
  const { accounts } = useTreasury();

  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Rediseño 2026-11-02 (igual que Clientes y Compras): alta plegada, buscador y filtros, una acción a la vez.
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState("");
  const [listFilter, setListFilter] = useState<"all" | "owed" | "overdue">("all");
  const [action, setAction] = useState<"debt" | "payment">("payment");
  const [ledgerRange, setLedgerRange] = useState<"month" | "quarter" | "all">("all");

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");

  const [editingCreditor, setEditingCreditor] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editNotesField, setEditNotesField] = useState("");
  const [editTermDays, setEditTermDays] = useState("");
  const [editActive, setEditActive] = useState(true);

  const [debtDate, setDebtDate] = useState(todayIso());
  const [debtAmount, setDebtAmount] = useState("");
  const [debtReason, setDebtReason] = useState("");
  const [debtAccountId, setDebtAccountId] = useState("");

  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");

  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editReason, setEditReason] = useState("");
  const [editAccountId, setEditAccountId] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const selectedCreditor = creditors.find((c) => c.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedCreditor) {
      setEditName(selectedCreditor.name);
      setEditPhone(selectedCreditor.phone ?? "");
      setEditNotesField(selectedCreditor.notes ?? "");
      setEditTermDays(selectedCreditor.paymentTermDays ? String(selectedCreditor.paymentTermDays) : "");
      setEditActive(selectedCreditor.active);
      setEditingCreditor(false);
    }
  }, [selectedCreditor]);

  function selectCreditor(id: string) {
    setSelectedId(id);
    void loadDetail(id);
  }

  // Arranca con el primero de la lista elegido: la derecha nunca queda vacía.
  useEffect(() => {
    if (!selectedId && creditors.length > 0) selectCreditor(creditors[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, creditors]);

  async function handleUpdateCreditor() {
    if (busy || !selectedCreditor) return;
    setBusy(true);
    try {
      if (!editName.trim()) throw new Error("El nombre es obligatorio.");
      const termDays = editTermDays.trim() ? Number(editTermDays) : undefined;
      if (termDays !== undefined && (!Number.isFinite(termDays) || termDays <= 0)) throw new Error("El plazo tiene que ser un número mayor que cero.");
      await update({
        id: selectedCreditor.id,
        name: editName.trim(),
        phone: editPhone.trim() || undefined,
        notes: editNotesField.trim() || undefined,
        paymentTermDays: termDays,
        active: editActive
      });
      setEditingCreditor(false);
      if (!editActive) setSelectedId(null);
      setMessage(editActive ? "Acreedor actualizado." : "Acreedor eliminado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo actualizar el acreedor.");
    } finally {
      setBusy(false);
    }
  }

  const ledger = useMemo<LedgerRow[]>(() => {
    const rows: Omit<LedgerRow, "balance">[] = [
      ...debts.map((d) => ({
        key: `debt-${d.id}`,
        type: "debt" as const,
        id: d.id,
        date: d.debtDate,
        detail: `Deuda · ${d.reason}${d.accountName ? ` · entró a ${d.accountName}` : ""}`,
        debit: d.amount,
        credit: 0
      })),
      ...payments.map((p) => ({
        key: `payment-${p.id}`,
        type: "payment" as const,
        id: p.id,
        date: p.paymentDate,
        detail: `Pago · ${p.accountName ?? "-"}${p.notes ? ` · ${p.notes}` : ""}`,
        debit: 0,
        credit: p.amount
      }))
    ].sort((a, b) => a.date.localeCompare(b.date));

    let running = 0;
    return rows.map((row) => {
      running += row.debit - row.credit;
      return { ...row, balance: running };
    });
  }, [debts, payments]);

  async function handleCreateCreditor() {
    if (busy) return;
    setBusy(true);
    try {
      if (!name.trim()) throw new Error("El nombre es obligatorio.");
      const result = await create({ name: name.trim(), phone: phone.trim() || undefined, notes: notes.trim() || undefined });
      setName("");
      setPhone("");
      setNotes("");
      setShowNew(false);
      selectCreditor(result.id);
      setMessage("Acreedor creado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear el acreedor.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddDebt() {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedCreditor) return;
      const amount = parseAmount(debtAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!debtReason.trim()) throw new Error("Ingresá un motivo (ej. préstamo, mercadería).");
      await addDebt({ creditorId: selectedCreditor.id, debtDate, amount, reason: debtReason.trim(), accountId: debtAccountId || undefined });
      setDebtAmount("");
      setDebtReason("");
      setDebtAccountId("");
      setMessage("Deuda cargada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar la deuda.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRegisterPayment() {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedCreditor) return;
      const amount = parseAmount(paymentAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!paymentAccountId) throw new Error("Elegí de qué cuenta sale el pago.");
      const result = await registerPayment({
        creditorId: selectedCreditor.id,
        paymentDate,
        amount,
        accountId: paymentAccountId,
        notes: paymentNotes.trim() || undefined
      });
      setPaymentAmount("");
      setPaymentAccountId("");
      setPaymentNotes("");
      setMessage(`Pago registrado. Saldo restante: ${formatMoney(result.balance)}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar el pago.");
    } finally {
      setBusy(false);
    }
  }

  function startEditRow(row: LedgerRow) {
    setEditingRowKey(row.key);
    setEditDate(row.date);
    if (row.type === "debt") {
      const debt = debts.find((d) => d.id === row.id);
      setEditAmount(String(debt?.amount ?? ""));
      setEditReason(debt?.reason ?? "");
      setEditAccountId(debt?.accountId ?? "");
    } else {
      const payment = payments.find((p) => p.id === row.id);
      setEditAmount(String(payment?.amount ?? ""));
      setEditAccountId(payment?.accountId ?? "");
      setEditNotes(payment?.notes ?? "");
    }
  }

  async function handleSaveRow(row: LedgerRow) {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedCreditor) return;
      const amount = parseAmount(editAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");

      if (row.type === "debt") {
        if (!editReason.trim()) throw new Error("Ingresá un motivo.");
        await editDebt(selectedCreditor.id, {
          id: row.id,
          debtDate: editDate,
          amount,
          reason: editReason.trim(),
          accountId: editAccountId || undefined
        });
      } else {
        if (!editAccountId) throw new Error("Elegí de qué cuenta sale el pago.");
        await editPayment(selectedCreditor.id, {
          id: row.id,
          paymentDate: editDate,
          amount,
          accountId: editAccountId,
          notes: editNotes.trim() || undefined
        });
      }
      setEditingRowKey(null);
      setMessage(row.type === "debt" ? "Deuda actualizada." : "Pago actualizado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar el cambio.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRow(row: LedgerRow) {
    if (busy) return;
    const label = row.type === "debt" ? "esta deuda" : "este pago";
    if (!window.confirm(`¿Seguro que querés borrar ${label}? No se puede deshacer.`)) return;
    setBusy(true);
    try {
      if (!selectedCreditor) return;
      if (row.type === "debt") {
        await removeDebt(selectedCreditor.id, row.id);
        setMessage("Deuda borrada.");
      } else {
        await removePayment(selectedCreditor.id, row.id);
        setMessage("Pago borrado.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo borrar.");
    } finally {
      setBusy(false);
    }
  }

  function handlePrint() {
    window.print();
  }

  const today = todayIso();
  const owedTotal = creditors.reduce((sum, c) => (c.balance >= 1 ? sum + c.balance : sum), 0);
  const owedCount = creditors.filter((c) => c.balance >= 1).length;
  const overdueCount = creditors.filter((c) => isOverdueDebt(c, today)).length;
  const visibleCreditors = creditors.filter((c) => {
    if (search.trim() && !c.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (listFilter === "owed") return c.balance >= 1;
    if (listFilter === "overdue") return isOverdueDebt(c, today);
    return true;
  });
  const selectedInfo = selectedCreditor ? creditors.find((c) => c.id === selectedCreditor.id) : undefined;
  const owed = balance?.balance ?? 0;
  const lastPayment = payments.reduce<string | null>((max, p) => (max === null || p.paymentDate > max ? p.paymentDate : max), null);
  // Mismo plazo que "Atrasado" (isOverdueDebt): días desde el último pago, o desde la deuda más vieja si nunca pagó.
  const dueDate = selectedInfo && selectedInfo.paymentTermDays && selectedInfo.lastActivityDate && owed >= 1 ? addDaysIso(selectedInfo.lastActivityDate, selectedInfo.paymentTermDays) : null;
  const dueInDays = dueDate ? Math.round((new Date(`${dueDate}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000) : null;
  const ledgerCutoff = ledgerRange === "all" ? null : addDaysIso(today, ledgerRange === "month" ? -30 : -90);
  const visibleLedger = [...ledger].reverse().filter((row) => !ledgerCutoff || row.date >= ledgerCutoff);
  const amountTyped = parseAmount((action === "payment" ? paymentAmount : debtAmount) || "0") || 0;

  return (
    <>
      <header className="page-header no-print">
        <div>
          <p className="eyebrow">DEUDAS</p>
          <h1>Deudas y acreedores</h1>
          <p className="muted">Gente a la que le debés plata (préstamos, proveedores informales, etc.): los pagos bajan el saldo y la caja.</p>
        </div>
      </header>

      {message && <div className="message no-print">{message}</div>}
      {error && <div className="message warning no-print">{error}</div>}

      <div className="ws-layout">
        <section className="panel ws-list no-print">
          <div className="panel-title">
            <h2>Acreedores <span className="badge">{loading ? "…" : creditors.length}</span></h2>
            {!showNew && <button className="secondary" onClick={() => setShowNew(true)}>+ Nuevo</button>}
          </div>
          {showNew && (
            <div className="form-box" style={{ marginBottom: 12 }}>
              <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Acreedor nuevo</h3>
              <div className="form-grid">
                <label>Nombre<input value={name} onChange={(e) => setName(e.target.value)} /></label>
                <label>Teléfono (opcional)<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
                <label>Nota (opcional)<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
              </div>
              <div className="form-actions">
                <button disabled={busy} onClick={handleCreateCreditor}>Agregar acreedor</button>
                <button className="secondary" onClick={() => setShowNew(false)}>Cancelar</button>
              </div>
            </div>
          )}
          {owedCount > 0 && <p className="ws-list-total">Les debés <b>{formatMoney(owedTotal)}</b> entre {owedCount}</p>}
          <input style={{ width: "100%", marginBottom: 8 }} placeholder="Buscar" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="ws-chips">
            <button className={listFilter === "all" ? "ws-chip active" : "ws-chip"} onClick={() => setListFilter("all")}>Todos ({creditors.length})</button>
            <button className={listFilter === "owed" ? "ws-chip active" : "ws-chip"} onClick={() => setListFilter("owed")}>Les debo ({owedCount})</button>
            <button className={listFilter === "overdue" ? "ws-chip active" : "ws-chip"} onClick={() => setListFilter("overdue")}>Atrasados ({overdueCount})</button>
          </div>
          <div className="ws-list-items">
            {visibleCreditors.map((c) => {
              const overdue = isOverdueDebt(c, today);
              return (
                <button key={c.id} className={c.id === selectedId ? "ws-item active" : "ws-item"} onClick={() => selectCreditor(c.id)}>
                  <span className="ws-item-main">
                    <b>{c.name}</b>
                    <small>
                      {c.paymentTermDays ? `Plazo ${c.paymentTermDays} días · ` : ""}
                      {c.lastActivityDate ? shortDate(c.lastActivityDate) : "sin movimientos"}
                    </small>
                  </span>
                  <span className="ws-item-side">
                    <b className={c.balance >= 1 ? "num-negative" : "num-positive"}>{formatMoney(c.balance)}</b>
                    {overdue && <span className="badge warn">Atrasado</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {creditors.length === 0 && !loading && <p className="muted">Todavía no cargaste ningún acreedor.</p>}
          {creditors.length > 0 && visibleCreditors.length === 0 && <p className="muted">Ningún acreedor coincide.</p>}
        </section>

        <section className="panel ws-main print-area">
          {!selectedCreditor && <p className="muted">Elegí un acreedor de la lista para ver su cuenta.</p>}
          {selectedCreditor && (
            <>
              <div className="ws-head">
                <div>
                  <h2>{selectedCreditor.name}</h2>
                  <p className="muted">
                    {[
                      selectedCreditor.paymentTermDays ? `Plazo de pago ${selectedCreditor.paymentTermDays} días` : "Sin plazo de pago",
                      selectedCreditor.phone ?? "",
                      selectedCreditor.notes ?? ""
                    ].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="row-actions no-print">
                  <button className="secondary" onClick={() => setEditingCreditor((v) => !v)}>Editar</button>
                  <button className="secondary" onClick={handlePrint}>Imprimir</button>
                </div>
              </div>

              {editingCreditor && (
                <div className="form-box no-print" style={{ marginTop: 12 }}>
                  <div className="form-grid">
                    <label>Nombre<input value={editName} onChange={(e) => setEditName(e.target.value)} /></label>
                    <label>Teléfono<input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} /></label>
                    <label>Nota<input value={editNotesField} onChange={(e) => setEditNotesField(e.target.value)} /></label>
                    <label title="Cada cuántos días le tenés que pagar: con esto se marca Atrasado y se avisa el próximo pago">
                      Plazo de pago (días)
                      <input type="number" value={editTermDays} onChange={(e) => setEditTermDays(e.target.value)} />
                    </label>
                    <label>
                      Estado
                      <select value={editActive ? "1" : "0"} onChange={(e) => setEditActive(e.target.value === "1")}>
                        <option value="1">Activo</option>
                        <option value="0">Inactivo (eliminado)</option>
                      </select>
                    </label>
                  </div>
                  <div className="form-actions">
                    <button disabled={busy} onClick={handleUpdateCreditor}>Guardar</button>
                    <button className="secondary" disabled={busy} onClick={() => setEditingCreditor(false)}>Cancelar</button>
                  </div>
                </div>
              )}

              <div className="ws-summary">
                <div className={owed >= 1 ? "bad" : owed <= -1 ? "good" : ""}>
                  <span>{owed <= -1 ? "Pagaste de más" : "Le debés hoy"}</span>
                  <strong>{formatMoney(Math.abs(owed))}</strong>
                </div>
                <div><span>Te prestó / te fió (total)</span><strong>{formatMoney(balance?.totalDebt ?? 0)}</strong><small>{debts.length} {debts.length === 1 ? "deuda" : "deudas"}</small></div>
                <div><span>Le pagaste (total)</span><strong className="num-positive">{formatMoney(balance?.totalPaid ?? 0)}</strong><small>{payments.length} {payments.length === 1 ? "pago" : "pagos"}</small></div>
                <div><span>Último pago</span><strong>{lastPayment ? shortDate(lastPayment) : "—"}</strong></div>
              </div>

              {dueDate && dueInDays !== null && (
                <div className={dueInDays < 0 ? "message warning no-print" : "ws-note no-print"} style={{ marginTop: 10, marginBottom: 0 }}>
                  {dueInDays < 0
                    ? <>Está <b>atrasado</b>: tenías que pagarle antes del <b>{shortDate(dueDate)}</b> (hace {-dueInDays} {dueInDays === -1 ? "día" : "días"}).</>
                    : <>⏰ Próximo pago antes del <b>{shortDate(dueDate)}</b> ({dueInDays === 0 ? "hoy" : `en ${dueInDays} ${dueInDays === 1 ? "día" : "días"}`}).</>}
                </div>
              )}

              <div className="ws-seg no-print">
                <button className={action === "debt" ? "active" : ""} onClick={() => setAction("debt")}>+ Nueva deuda</button>
                <button className={action === "payment" ? "active" : ""} onClick={() => setAction("payment")}>Registrar pago</button>
              </div>

              {action === "debt" && (
                <div className="ws-form no-print">
                  <div className="ws-form-row">
                    <label className="ws-field">Monto<input type="text" inputMode="decimal" value={debtAmount} onChange={(e) => setDebtAmount(e.target.value)} style={{ width: 150 }} /></label>
                    <label className="ws-field">
                      ¿Entró plata?
                      <select value={debtAccountId} onChange={(e) => setDebtAccountId(e.target.value)}>
                        <option value="">No (mercadería, servicio…)</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>Sí, a {a.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="ws-field">Fecha<input type="date" value={debtDate} onChange={(e) => setDebtDate(e.target.value)} /></label>
                  </div>
                  <div className="ws-form-row" style={{ marginTop: 10 }}>
                    <label className="ws-field ws-grow">Motivo<input placeholder="Ej. préstamo, mercadería" value={debtReason} onChange={(e) => setDebtReason(e.target.value)} /></label>
                    <button disabled={busy} onClick={handleAddDebt}>{busy ? "Cargando…" : "Cargar deuda"}</button>
                  </div>
                  {amountTyped > 0 && <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>Le vas a deber <b>{formatMoney(owed + amountTyped)}</b>.</p>}
                </div>
              )}

              {action === "payment" && (
                <div className="ws-form no-print">
                  <div className="ws-form-row">
                    <label className="ws-field">Monto<input type="text" inputMode="decimal" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} style={{ width: 150 }} /></label>
                    <label className="ws-field">
                      Sale de
                      <select value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}>
                        <option value="">Elegí la cuenta…</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="ws-field ws-grow">Nota (opcional)<input placeholder="Ej. cuota 7 de 20" value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} /></label>
                    <label className="ws-field">Fecha<input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} /></label>
                    <button disabled={busy} onClick={handleRegisterPayment}>{busy ? "Registrando…" : "Registrar pago"}</button>
                  </div>
                  {amountTyped > 0 && <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>Después del pago le vas a deber <b>{formatMoney(owed - amountTyped)}</b>.</p>}
                </div>
              )}

              <div className="ws-box">
                <h3>
                  Cuenta corriente
                  <span className="ws-chips no-print" style={{ margin: 0 }}>
                    {(
                      [
                        ["month", "Último mes"],
                        ["quarter", "3 meses"],
                        ["all", "Todo"]
                      ] as ["month" | "quarter" | "all", string][]
                    ).map(([value, label]) => (
                      <button key={value} className={ledgerRange === value ? "ws-chip active" : "ws-chip"} onClick={() => setLedgerRange(value)}>{label}</button>
                    ))}
                  </span>
                </h3>
                <div className="ws-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Concepto</th>
                        <th className="num">Debe</th>
                        <th className="num">Pagaste</th>
                        <th className="num">Saldo</th>
                        <th className="no-print"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleLedger.map((row) =>
                        editingRowKey === row.key ? (
                          <tr key={row.key} className="row-editor no-print">
                            <td colSpan={6}>
                              <div className="ws-form-row">
                                <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                                {row.type === "debt" ? (
                                  <input placeholder="Motivo" value={editReason} onChange={(e) => setEditReason(e.target.value)} style={{ flex: "1 1 200px", minWidth: 0 }} />
                                ) : (
                                  <input placeholder="Nota" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} style={{ flex: "1 1 200px", minWidth: 0 }} />
                                )}
                                <input type="text" inputMode="decimal" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} style={{ width: 120 }} />
                                <select value={editAccountId} onChange={(e) => setEditAccountId(e.target.value)}>
                                  <option value="">{row.type === "debt" ? "No entró plata" : "Pagar desde…"}</option>
                                  {accounts.map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                  ))}
                                </select>
                                <button disabled={busy} onClick={() => handleSaveRow(row)}>Guardar</button>
                                <button className="secondary" disabled={busy} onClick={() => setEditingRowKey(null)}>Cancelar</button>
                              </div>
                            </td>
                          </tr>
                        ) : (
                          <tr key={row.key}>
                            <td className="ws-date">{shortDate(row.date)}</td>
                            <td>{row.detail}</td>
                            <td className="num">{row.debit > 0 ? formatMoney(row.debit) : ""}</td>
                            <td className="num num-positive">{row.credit > 0 ? formatMoney(row.credit) : ""}</td>
                            <td className="num"><b>{formatMoney(row.balance)}</b></td>
                            <td className="no-print">
                              <div className="ws-row-actions">
                                <button className="secondary" disabled={busy} onClick={() => startEditRow(row)}>Editar</button>
                                <button className="secondary" disabled={busy} onClick={() => handleDeleteRow(row)}>Borrar</button>
                              </div>
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                  {ledger.length === 0 && !detailLoading && <p className="muted ws-empty">Todavía no hay movimientos para este acreedor.</p>}
                  {ledger.length > 0 && visibleLedger.length === 0 && <p className="muted ws-empty">No hubo movimientos en este período. Tocá "Todo" para ver los anteriores.</p>}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
