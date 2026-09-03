import { Fragment, useMemo, useState } from "react";
import { useCustomers } from "./useCustomers";
import { useTreasury } from "../shifts/useTreasury";
import { todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

interface LedgerRow {
  key: string;
  type: "charge" | "payment";
  id: string;
  date: string;
  detail: string;
  debit: number;
  credit: number;
  balance: number;
}

export function Customers() {
  const {
    customers,
    loading,
    error,
    create,
    charges,
    payments,
    balance,
    detailLoading,
    loadDetail,
    addCharge,
    registerPayment,
    editCharge,
    removeCharge,
    editPayment,
    removePayment
  } = useCustomers();
  const { accounts } = useTreasury();

  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");

  const [chargeDate, setChargeDate] = useState(todayIso());
  const [chargeAmount, setChargeAmount] = useState("");
  const [chargeReason, setChargeReason] = useState("");

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

  const selectedCustomer = customers.find((c) => c.id === selectedId) ?? null;

  function selectCustomer(id: string) {
    setSelectedId(id);
    void loadDetail(id);
  }

  const ledger = useMemo<LedgerRow[]>(() => {
    const rows: Omit<LedgerRow, "balance">[] = [
      ...charges.map((c) => ({
        key: `charge-${c.id}`,
        type: "charge" as const,
        id: c.id,
        date: c.chargeDate,
        detail: `Entrega · ${c.reason}`,
        debit: c.amount,
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
  }, [charges, payments]);

  async function handleCreateCustomer() {
    if (busy) return;
    setBusy(true);
    try {
      if (!name.trim()) throw new Error("El nombre es obligatorio.");
      const result = await create({ name: name.trim(), phone: phone.trim() || undefined, notes: notes.trim() || undefined });
      setName("");
      setPhone("");
      setNotes("");
      selectCustomer(result.id);
      setMessage("Cliente creado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear el cliente.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddCharge() {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedCustomer) return;
      const amount = parseAmount(chargeAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!chargeReason.trim()) throw new Error("Ingresá un detalle (ej. qué le entregaste).");
      await addCharge({ customerId: selectedCustomer.id, chargeDate, amount, reason: chargeReason.trim() });
      setChargeAmount("");
      setChargeReason("");
      setMessage("Entrega cargada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar la entrega.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRegisterPayment() {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedCustomer) return;
      const amount = parseAmount(paymentAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!paymentAccountId) throw new Error("Elegí a qué cuenta entra el pago.");
      const result = await registerPayment({
        customerId: selectedCustomer.id,
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
    if (row.type === "charge") {
      const charge = charges.find((c) => c.id === row.id);
      setEditAmount(String(charge?.amount ?? ""));
      setEditReason(charge?.reason ?? "");
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
      if (!selectedCustomer) return;
      const amount = parseAmount(editAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");

      if (row.type === "charge") {
        if (!editReason.trim()) throw new Error("Ingresá un detalle.");
        await editCharge(selectedCustomer.id, { id: row.id, chargeDate: editDate, amount, reason: editReason.trim() });
      } else {
        if (!editAccountId) throw new Error("Elegí a qué cuenta entra el pago.");
        await editPayment(selectedCustomer.id, {
          id: row.id,
          paymentDate: editDate,
          amount,
          accountId: editAccountId,
          notes: editNotes.trim() || undefined
        });
      }
      setEditingRowKey(null);
      setMessage(row.type === "charge" ? "Entrega actualizada." : "Pago actualizado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar el cambio.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRow(row: LedgerRow) {
    if (busy) return;
    setBusy(true);
    try {
      if (!selectedCustomer) return;
      if (row.type === "charge") {
        await removeCharge(selectedCustomer.id, row.id);
        setMessage("Entrega borrada.");
      } else {
        await removePayment(selectedCustomer.id, row.id);
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

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">CLIENTES</p>
          <h1>Clientes y cuenta corriente</h1>
          <p className="muted">Clientes a los que les entregás mercadería sin cobrar en el momento (mayoristas, etc.) — los pagos que te hacen bajan el saldo y suben la caja.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      <div className="content-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Clientes</h2>
            <span>{loading ? "Cargando…" : `${customers.length}`}</span>
          </div>
          <table className="data-table">
            <thead>
              <tr><th>Nombre</th><th></th></tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    <button className={c.id === selectedId ? "" : "secondary"} onClick={() => selectCustomer(c.id)}>
                      {c.id === selectedId ? "Seleccionado" : "Ver cuenta"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {customers.length === 0 && !loading && <p className="muted">Todavía no cargaste ningún cliente.</p>}

          <div className="cash-banner-form" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="Teléfono (opcional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <input placeholder="Nota (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <button disabled={busy} onClick={handleCreateCustomer}>Agregar cliente</button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Cuenta corriente</h2>
          </div>
          {!selectedCustomer && <p className="muted">Elegí un cliente para ver su cuenta.</p>}
          {selectedCustomer && (
            <div className="totals">
              <span>Cliente <b>{selectedCustomer.name}</b></span>
              <span>Total entregado <b>{formatMoney(balance?.totalCharged ?? 0)}</b></span>
              <span>Pagado <b>{formatMoney(balance?.totalPaid ?? 0)}</b></span>
              <strong>Saldo (te debe) <b>{formatMoney(balance?.balance ?? 0)}</b></strong>
            </div>
          )}
        </section>
      </div>

      {selectedCustomer && (
        <>
          <section className="panel print-area" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Detalle de cuenta corriente</h2>
              <button className="secondary no-print" onClick={handlePrint}>Imprimir</button>
            </div>
            <p className="muted print-only-header">{selectedCustomer.name}</p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Concepto</th>
                  <th className="num">Debe</th>
                  <th className="num">Haber</th>
                  <th className="num">Saldo</th>
                  <th className="no-print"></th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) =>
                  editingRowKey === row.key ? (
                    <Fragment key={row.key}>
                      <tr className="no-print">
                        <td><input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} /></td>
                        <td>
                          {row.type === "charge" ? (
                            <input placeholder="Detalle" value={editReason} onChange={(e) => setEditReason(e.target.value)} />
                          ) : (
                            <input placeholder="Nota" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
                          )}
                        </td>
                        <td colSpan={2}>
                          <input
                            type="text"
                            inputMode="decimal"
                            className="num"
                            value={editAmount}
                            onChange={(e) => setEditAmount(e.target.value)}
                            style={{ width: 100 }}
                          />{" "}
                          {row.type === "payment" && (
                            <select value={editAccountId} onChange={(e) => setEditAccountId(e.target.value)}>
                              <option value="">Entra a…</option>
                              {accounts.map((a) => (
                                <option key={a.id} value={a.id}>{a.name}</option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td colSpan={2}>
                          <button disabled={busy} onClick={() => handleSaveRow(row)}>Guardar</button>{" "}
                          <button className="secondary" disabled={busy} onClick={() => setEditingRowKey(null)}>Cancelar</button>
                        </td>
                      </tr>
                    </Fragment>
                  ) : (
                    <tr key={row.key}>
                      <td>{row.date}</td>
                      <td>{row.detail}</td>
                      <td className="num">{row.debit > 0 ? formatMoney(row.debit) : "-"}</td>
                      <td className="num">{row.credit > 0 ? formatMoney(row.credit) : "-"}</td>
                      <td className="num">{formatMoney(row.balance)}</td>
                      <td className="no-print">
                        <button className="secondary" disabled={busy} onClick={() => startEditRow(row)}>Editar</button>{" "}
                        <button className="secondary" disabled={busy} onClick={() => handleDeleteRow(row)}>Borrar</button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
            {ledger.length === 0 && !detailLoading && <p className="muted">Todavía no hay movimientos para este cliente.</p>}
          </section>

          <div className="content-grid" style={{ marginTop: 18 }}>
            <section className="panel">
              <div className="panel-title">
                <h2>Nueva entrega</h2>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
                <input type="date" value={chargeDate} onChange={(e) => setChargeDate(e.target.value)} />
                <input type="text" inputMode="decimal" placeholder="Monto" value={chargeAmount} onChange={(e) => setChargeAmount(e.target.value)} />
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                <input placeholder="Detalle (ej. 20kg asado, factura #123)" value={chargeReason} onChange={(e) => setChargeReason(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
                <button disabled={busy} onClick={handleAddCharge}>{busy ? "Cargando…" : "Cargar entrega"}</button>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">
                <h2>Registrar pago</h2>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
                <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
                <input type="text" inputMode="decimal" placeholder="Monto" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
                <select value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)}>
                  <option value="">Entra a…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                <input placeholder="Nota (opcional)" value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
                <button disabled={busy} onClick={handleRegisterPayment}>{busy ? "Registrando…" : "Registrar pago"}</button>
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
