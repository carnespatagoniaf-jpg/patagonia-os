import { useEffect, useMemo, useState } from "react";
import { parseAmount } from "../../lib/money";
import { formatMoney, todayIso } from "../shifts/format";
import { useTreasury } from "../shifts/useTreasury";
import type { TreasuryExpenseCategory } from "../shifts/treasury-service";
import { listExpenses, type ExpenseRow } from "./accounts-service";

/** Finanzas → "Gastos" (migración 143, a pedido de Martínez): los gastos
 * operativos en un solo lugar. Son los mismos de Tesorería → "Registrar gasto"
 * (register_treasury_expense): salen de una cuenta y bajan su saldo. */

const CATEGORY_OPTIONS: { value: TreasuryExpenseCategory; label: string }[] = [
  { value: "servicios", label: "Servicios (luz, gas, alquiler)" },
  { value: "mantenimiento", label: "Mantenimiento / reparaciones" },
  { value: "impuestos", label: "Impuestos" },
  { value: "insumos", label: "Insumos varios" },
  { value: "otro", label: "Otro (sueldos, combustible, flete…)" }
];
const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(CATEGORY_OPTIONS.map((o) => [o.value, o.label]));

function monthStart(iso: string) {
  return `${iso.slice(0, 7)}-01`;
}

function previousMonthRange(iso: string): [string, string] {
  const [y, m] = iso.split("-").map(Number);
  const start = new Date(y, m - 2, 1);
  const end = new Date(y, m - 1, 0);
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return [fmt(start), fmt(end)];
}

function errorText(err: unknown, fallback: string) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message) || fallback;
  return fallback;
}

export function Expenses() {
  const { accounts, registerExpense, removeExpense } = useTreasury();
  const today = todayIso();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const [date, setDate] = useState(today);
  const [accountId, setAccountId] = useState("");
  const [category, setCategory] = useState<TreasuryExpenseCategory>("servicios");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");

  async function load(nextFrom = from, nextTo = to) {
    setLoading(true);
    try {
      setRows(await listExpenses(nextFrom, nextTo));
    } catch (err) {
      setMessage(errorText(err, "No se pudieron cargar los gastos."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyRange(nextFrom: string, nextTo: string) {
    setFrom(nextFrom);
    setTo(nextTo);
    void load(nextFrom, nextTo);
  }

  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.category, (map.get(r.category) ?? 0) + r.amount);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  async function handleRegister() {
    if (busy) return;
    setBusy(true);
    try {
      if (!accountId) throw new Error("Elegí de qué cuenta sale el gasto.");
      const value = parseAmount(amount);
      if (!Number.isFinite(value) || value <= 0) throw new Error("Ingresá un monto válido.");
      if (!description.trim()) throw new Error("Escribí qué fue (ej. luz de octubre).");
      await registerExpense({ accountId, amount: value, category, description: description.trim(), expenseDate: date });
      setAmount("");
      setDescription("");
      setMessage("Gasto registrado.");
      await load();
    } catch (err) {
      setMessage(errorText(err, "No se pudo registrar el gasto."));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (busy) return;
    if (!window.confirm("¿Seguro que querés borrar este gasto? La plata vuelve a la cuenta de donde salió.")) return;
    setBusy(true);
    try {
      await removeExpense(id);
      setMessage("Gasto borrado.");
      await load();
    } catch (err) {
      setMessage(errorText(err, "No se pudo borrar el gasto."));
    } finally {
      setBusy(false);
    }
  }

  const [prevFrom, prevTo] = previousMonthRange(today);

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">FINANZAS</p>
          <h1>Gastos</h1>
          <p className="muted">Los gastos del negocio (luz, alquiler, sueldos, combustible…). Cada gasto sale de una cuenta de Tesorería y baja su saldo.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}

      <section className="panel no-print">
        <div className="panel-title">
          <h2>Registrar gasto</h2>
        </div>
        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">¿De qué cuenta sale?</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value as TreasuryExpenseCategory)}>
            {CATEGORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <input type="text" inputMode="decimal" placeholder="Monto" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
          <input placeholder="¿Qué fue? (ej. luz de octubre)" value={description} onChange={(e) => setDescription(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <button disabled={busy} onClick={handleRegister}>{busy ? "Guardando…" : "Registrar gasto"}</button>
        </div>
      </section>

      <div className="print-area" style={{ marginTop: 18 }}>
        <p className="muted print-only-header">Gastos del {from} al {to}</p>
        <section className="panel">
          <div className="panel-title">
            <h2>Gastos del período</h2>
            <button className="secondary no-print" onClick={() => window.print()}>Imprimir</button>
          </div>
          <div className="cash-banner-form no-print" style={{ flexWrap: "wrap", marginBottom: 12 }}>
            <button className="secondary" onClick={() => applyRange(monthStart(today), today)}>Este mes</button>
            <button className="secondary" onClick={() => applyRange(prevFrom, prevTo)}>Mes pasado</button>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <button onClick={() => void load()}>Ver</button>
          </div>

          <div className="totals">
            <strong>Total de gastos <b>{formatMoney(total)}</b></strong>
            {byCategory.map(([cat, value]) => (
              <span key={cat}>{CATEGORY_LABELS[cat] ?? cat} <b>{formatMoney(value)}</b></span>
            ))}
          </div>

          {loading && <p className="muted">Cargando…</p>}
          {!loading && rows.length === 0 && <p className="muted">No hay gastos en ese período.</p>}
          {rows.length > 0 && (
            <table className="data-table" style={{ marginTop: 12 }}>
              <thead>
                <tr><th>Fecha</th><th>Qué fue</th><th>Tipo</th><th>Cuenta</th><th className="num">Monto</th><th className="no-print"></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.date}</td>
                    <td>{r.description || "-"}</td>
                    <td>{CATEGORY_LABELS[r.category] ?? r.category}</td>
                    <td>{r.accountName}</td>
                    <td className="num">{formatMoney(r.amount)}</td>
                    <td className="no-print">
                      <button className="secondary" disabled={busy} onClick={() => handleDelete(r.id)}>Borrar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}
