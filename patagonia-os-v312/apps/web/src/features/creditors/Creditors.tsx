import { useMemo, useState } from "react";
import { useCreditors } from "./useCreditors";
import { useTreasury } from "../shifts/useTreasury";
import { todayIso } from "../shifts/format";
import { parseAmount } from "../../lib/money";

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
}

interface LedgerRow {
  key: string;
  date: string;
  detail: string;
  debit: number;
  credit: number;
  balance: number;
}

export function Creditors() {
  const { creditors, loading, error, create, debts, payments, balance, detailLoading, loadDetail, addDebt, registerPayment } = useCreditors();
  const { accounts } = useTreasury();

  const [message, setMessage] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");

  const [debtDate, setDebtDate] = useState(todayIso());
  const [debtAmount, setDebtAmount] = useState("");
  const [debtReason, setDebtReason] = useState("");

  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");

  const selectedCreditor = creditors.find((c) => c.id === selectedId) ?? null;

  function selectCreditor(id: string) {
    setSelectedId(id);
    void loadDetail(id);
  }

  const ledger = useMemo<LedgerRow[]>(() => {
    const rows = [
      ...debts.map((d) => ({ key: `debt-${d.id}`, date: d.debtDate, detail: `Deuda · ${d.reason}`, debit: d.amount, credit: 0 })),
      ...payments.map((p) => ({
        key: `payment-${p.id}`,
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
    try {
      if (!name.trim()) throw new Error("El nombre es obligatorio.");
      const result = await create({ name: name.trim(), phone: phone.trim() || undefined, notes: notes.trim() || undefined });
      setName("");
      setPhone("");
      setNotes("");
      selectCreditor(result.id);
      setMessage("Acreedor creado.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear el acreedor.");
    }
  }

  async function handleAddDebt() {
    try {
      if (!selectedCreditor) return;
      const amount = parseAmount(debtAmount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Ingresá un monto válido.");
      if (!debtReason.trim()) throw new Error("Ingresá un motivo (ej. préstamo, mercadería).");
      await addDebt({ creditorId: selectedCreditor.id, debtDate, amount, reason: debtReason.trim() });
      setDebtAmount("");
      setDebtReason("");
      setMessage("Deuda cargada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar la deuda.");
    }
  }

  async function handleRegisterPayment() {
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
      setPaymentNotes("");
      setMessage(`Pago registrado. Saldo restante: ${formatMoney(result.balance)}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo registrar el pago.");
    }
  }

  function handlePrint() {
    window.print();
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">DEUDAS</p>
          <h1>Deudas y acreedores</h1>
          <p className="muted">Gente a la que le debés plata (préstamos, proveedores informales, etc.) — los pagos bajan el saldo y la caja.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      <div className="content-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Acreedores</h2>
            <span>{loading ? "Cargando…" : `${creditors.length}`}</span>
          </div>
          <table className="data-table">
            <thead>
              <tr><th>Nombre</th><th></th></tr>
            </thead>
            <tbody>
              {creditors.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    <button className={c.id === selectedId ? "" : "secondary"} onClick={() => selectCreditor(c.id)}>
                      {c.id === selectedId ? "Seleccionado" : "Ver cuenta"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {creditors.length === 0 && !loading && <p className="muted">Todavía no cargaste ningún acreedor.</p>}

          <div className="cash-banner-form" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="Teléfono (opcional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <input placeholder="Nota (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <button onClick={handleCreateCreditor}>Agregar acreedor</button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Cuenta corriente</h2>
          </div>
          {!selectedCreditor && <p className="muted">Elegí un acreedor para ver su cuenta.</p>}
          {selectedCreditor && (
            <div className="totals">
              <span>Acreedor <b>{selectedCreditor.name}</b></span>
              <span>Deuda total <b>{formatMoney(balance?.totalDebt ?? 0)}</b></span>
              <span>Pagado <b>{formatMoney(balance?.totalPaid ?? 0)}</b></span>
              <strong>Saldo <b>{formatMoney(balance?.balance ?? 0)}</b></strong>
            </div>
          )}
        </section>
      </div>

      {selectedCreditor && (
        <>
          <section className="panel print-area" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Detalle de cuenta corriente</h2>
              <button className="secondary no-print" onClick={handlePrint}>Imprimir</button>
            </div>
            <p className="muted print-only-header">{selectedCreditor.name}</p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Concepto</th>
                  <th className="num">Debe</th>
                  <th className="num">Haber</th>
                  <th className="num">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.key}>
                    <td>{row.date}</td>
                    <td>{row.detail}</td>
                    <td className="num">{row.debit > 0 ? formatMoney(row.debit) : "-"}</td>
                    <td className="num">{row.credit > 0 ? formatMoney(row.credit) : "-"}</td>
                    <td className="num">{formatMoney(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ledger.length === 0 && !detailLoading && <p className="muted">Todavía no hay movimientos para este acreedor.</p>}
          </section>

          <div className="content-grid" style={{ marginTop: 18 }}>
            <section className="panel">
              <div className="panel-title">
                <h2>Nueva deuda</h2>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
                <input type="date" value={debtDate} onChange={(e) => setDebtDate(e.target.value)} />
                <input type="text" inputMode="decimal" placeholder="Monto" value={debtAmount} onChange={(e) => setDebtAmount(e.target.value)} />
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                <input placeholder="Motivo (ej. préstamo, mercadería)" value={debtReason} onChange={(e) => setDebtReason(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
                <button onClick={handleAddDebt}>Cargar deuda</button>
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
                  <option value="">Pagar desde…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
                <input placeholder="Nota (opcional)" value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
                <button onClick={handleRegisterPayment}>Registrar pago</button>
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
