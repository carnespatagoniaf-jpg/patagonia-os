import { useMemo, useState } from "react";
import type { PaymentMethod } from "@patagonia/domain";
import { useTreasury } from "./useTreasury";
import { useShifts } from "./useShifts";
import { addDaysIso, formatMoney, todayIso } from "./format";
import { parseAmount } from "../../lib/money";
import type { ShiftRangeRow } from "./shifts-service";

const PAYMENT_METHOD_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Efectivo" },
  { value: "qr", label: "Mercado Pago QR" },
  { value: "debit", label: "Débito" },
  { value: "credit", label: "Crédito" },
  { value: "bank_province", label: "Banco Provincia" },
  { value: "transfer", label: "Transferencia" }
];

const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  venta: "Venta",
  ajuste: "Ajuste",
  transferencia: "Transferencia",
  pago_proveedor: "Pago a proveedor",
  vale_mercaderia: "Vale · Mercadería",
  vale_adelanto: "Vale · Adelanto de sueldo",
  gasto: "Gasto"
};

export function Treasury() {
  const { accounts, balances, movements, loading, error, create, adjust, transfer } = useTreasury();
  const { loadRange } = useShifts();

  const [message, setMessage] = useState("");

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
  const [showNewAccountForm, setShowNewAccountForm] = useState(false);
  const [accountName, setAccountName] = useState("");
  const [accountPaymentMethod, setAccountPaymentMethod] = useState<PaymentMethod | "">("");
  const [accountInitialBalance, setAccountInitialBalance] = useState("");

  const [adjustAccountId, setAdjustAccountId] = useState("");
  const [adjustDirection, setAdjustDirection] = useState<"in" | "out">("out");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const [transferFromId, setTransferFromId] = useState("");
  const [transferToId, setTransferToId] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferReason, setTransferReason] = useState("");

  async function handleCreateAccount() {
    try {
      if (!accountName.trim()) throw new Error("El nombre de la cuenta es obligatorio.");
      const initialBalance = accountInitialBalance ? parseAmount(accountInitialBalance) : 0;
      if (!Number.isFinite(initialBalance) || initialBalance < 0) throw new Error("El saldo inicial no puede ser negativo.");
      await create({ name: accountName.trim(), paymentMethod: accountPaymentMethod || undefined, initialBalance });
      setAccountName("");
      setAccountPaymentMethod("");
      setAccountInitialBalance("");
      setShowNewAccountForm(false);
      setMessage("Cuenta creada.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo crear la cuenta.");
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

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">TESORERÍA</p>
          <h1>Tesorería</h1>
          <p className="muted">Saldos por cuenta, ajustes por diferencias y transferencias entre cuentas.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      <section className="panel">
        <div className="panel-title">
          <h2>Saldos</h2>
          <span>{loading ? "Cargando…" : `${accounts.length} cuentas`}</span>
        </div>
        <div className="kpi-grid">
          {balances.map((balance) => (
            <div className="kpi-card" key={balance.accountId}>
              <span>{balance.name}</span>
              <strong>{formatMoney(balance.balance)}</strong>
            </div>
          ))}
        </div>
        {showNewAccountForm ? (
          <div className="cash-banner-form" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <input placeholder="Nombre de cuenta" value={accountName} onChange={(e) => setAccountName(e.target.value)} />
            <select value={accountPaymentMethod} onChange={(e) => setAccountPaymentMethod(e.target.value as PaymentMethod | "")}>
              <option value="">Otros / sin medio fijo</option>
              {PAYMENT_METHOD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <input
              type="text"
              inputMode="decimal"
              placeholder="Saldo inicial"
              value={accountInitialBalance}
              onChange={(e) => setAccountInitialBalance(e.target.value)}
            />
            <button onClick={handleCreateAccount}>Guardar cuenta</button>
            <button className="secondary" onClick={() => setShowNewAccountForm(false)}>Cancelar</button>
          </div>
        ) : (
          <button className="secondary" style={{ marginTop: 16 }} onClick={() => setShowNewAccountForm(true)}>
            + Agregar cuenta
          </button>
        )}
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Ventas por fecha</h2>
        </div>
        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 14 }}>
          <input type="date" value={salesFrom} onChange={(e) => setSalesFrom(e.target.value)} />
          <input type="date" value={salesTo} onChange={(e) => setSalesTo(e.target.value)} />
          <button onClick={() => runSalesByDate(salesFrom, salesTo)}>Buscar</button>
          <button className="secondary" onClick={() => runSalesByDate(todayIso(), todayIso())}>Hoy</button>
          <button className="secondary" onClick={() => runSalesByDate(addDaysIso(todayIso(), -6), todayIso())}>Esta semana</button>
          <button className="secondary" onClick={() => runSalesByDate(addDaysIso(todayIso(), -29), todayIso())}>Este mes</button>
        </div>
        {salesLoading ? (
          <p className="muted">Cargando…</p>
        ) : !salesRanOnce ? (
          <p className="muted">Elegí un rango para ver las ventas por fecha.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Fecha</th>
                {accounts.map((account) => (
                  <th key={account.id} className="num">{account.name}</th>
                ))}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {salesByDay.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  {day.perAccount.map((a) => (
                    <td key={a.accountId} className="num">{formatMoney(a.amount)}</td>
                  ))}
                  <td className="num">{formatMoney(day.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {salesRanOnce && !salesLoading && salesByDay.length === 0 && (
          <p className="muted">No hay ventas cargadas en ese rango.</p>
        )}
      </section>

      <div className="content-grid" style={{ marginTop: 18 }}>
        <section className="panel">
          <div className="panel-title">
            <h2>Ajustar cuenta</h2>
          </div>
          <p className="muted" style={{ marginBottom: 14 }}>
            Para diferencias por comisiones, errores de caja u otros detalles.
          </p>
          <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
            <select value={adjustAccountId} onChange={(e) => setAdjustAccountId(e.target.value)}>
              <option value="">Cuenta…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <select value={adjustDirection} onChange={(e) => setAdjustDirection(e.target.value as "in" | "out")}>
              <option value="out">Restar</option>
              <option value="in">Sumar</option>
            </select>
            <input type="text" inputMode="decimal" placeholder="Monto" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} />
          </div>
          <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
            <input placeholder="Motivo (ej. comisión Mercado Pago)" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
            <button onClick={handleAdjust}>Registrar ajuste</button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Transferir entre cuentas</h2>
          </div>
          <p className="muted" style={{ marginBottom: 14 }}>
            Ej: pasar de Mercado Pago a Banco Provincia.
          </p>
          <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
            <select value={transferFromId} onChange={(e) => setTransferFromId(e.target.value)}>
              <option value="">Desde…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <select value={transferToId} onChange={(e) => setTransferToId(e.target.value)}>
              <option value="">Hacia…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <input type="text" inputMode="decimal" placeholder="Monto" value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)} />
          </div>
          <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
            <input placeholder="Nota (opcional)" value={transferReason} onChange={(e) => setTransferReason(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
            <button onClick={handleTransfer}>Transferir</button>
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Movimientos recientes</h2>
        </div>
        <table className="data-table">
          <thead>
            <tr><th>Fecha</th><th>Cuenta</th><th>Tipo</th><th>Dirección</th><th className="num">Monto</th><th>Nota</th></tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td>{m.occurredOn}</td>
                <td>{m.accountName}</td>
                <td>{MOVEMENT_TYPE_LABELS[m.movementType] ?? m.movementType}</td>
                <td className={m.direction === "in" ? "num-positive" : "num-negative"}>{m.direction === "in" ? "Entrada" : "Salida"}</td>
                <td className="num">{formatMoney(m.amount)}</td>
                <td>{m.notes ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {movements.length === 0 && <p className="muted">Todavía no hay movimientos.</p>}
      </section>
    </>
  );
}
