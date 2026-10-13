import { useCallback, useEffect, useState } from "react";
import { parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import type { useTreasury } from "../shifts/useTreasury";
import { CLOSE_OK_TOLERANCE } from "./cash-close";
import {
  countSafe,
  listPosShiftCloses,
  listSafeAccounts,
  listSafeCounts,
  listSafeDeposits,
  listSafeWithdrawals,
  type SafeAccount,
  type SafeCount,
  type SafeDeposit,
  type SafeWithdrawal,
  type ShiftCloseRow
} from "./cash-control-service";

// "Control de caja" para el dueño/admin, abajo de Mostrador (migración 117):
// cuánto tiene que haber en la caja fuerte según los papelitos, contarla, y
// los últimos cierres con el PRIMER conteo de cada cajera.

type Adjust = ReturnType<typeof useTreasury>["adjust"];

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function diffText(diff: number | null) {
  if (diff === null) return "-";
  if (Math.abs(diff) < 1) return "justo";
  if (Math.abs(diff) <= CLOSE_OK_TOLERANCE) return `${diff > 0 ? "+" : "−"}${formatMoney(Math.abs(diff))}`;
  return diff > 0 ? `sobra ${formatMoney(diff)}` : `falta ${formatMoney(-diff)}`;
}

function diffClass(diff: number | null) {
  if (diff === null) return "muted";
  return Math.abs(diff) <= CLOSE_OK_TOLERANCE ? "num-positive" : "num-negative";
}

function SafeBlock({ safe, onMessage, adjust, onChanged }: { safe: SafeAccount; onMessage: (m: string) => void; adjust: Adjust; onChanged: () => Promise<void> }) {
  const [lastCount, setLastCount] = useState<SafeCount | null>(null);
  const [deposits, setDeposits] = useState<SafeDeposit[]>([]);
  const [withdrawals, setWithdrawals] = useState<SafeWithdrawal[]>([]);
  const [mode, setMode] = useState<null | "count" | "withdraw">(null);
  const [amountInput, setAmountInput] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [countResult, setCountResult] = useState<{ expected: number; difference: number } | null>(null);
  const [showDeposits, setShowDeposits] = useState(false);

  const load = useCallback(async () => {
    const counts = await listSafeCounts(safe.id, 1);
    const since = counts[0]?.createdAt ?? null;
    setLastCount(counts[0] ?? null);
    const [d, w] = await Promise.all([listSafeDeposits(safe.id, since), listSafeWithdrawals(safe.id, since)]);
    setDeposits(d);
    setWithdrawals(w);
  }, [safe.id]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  async function submit() {
    onMessage("");
    const amount = parseAmount(amountInput || "");
    if (!Number.isFinite(amount) || amount < 0 || (mode === "withdraw" && amount <= 0)) {
      onMessage("Poné un monto válido.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "count") {
        setCountResult(await countSafe(safe.id, amount, reason));
      } else {
        await adjust({ accountId: safe.id, amount, direction: "out", reason: reason.trim() || "Saqué plata de la caja fuerte" });
        onMessage(`Anotado: sacaste ${formatMoney(amount)} de la caja fuerte.`);
      }
      setAmountInput("");
      setReason("");
      setMode(null);
      await onChanged();
      await load();
    } catch (err) {
      onMessage(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  const active = deposits.filter((d) => !d.voidedAt);
  const voided = deposits.filter((d) => d.voidedAt);

  return (
    <div className="panel" style={{ padding: 14, marginBottom: 14 }}>
      <p style={{ margin: 0, fontWeight: 700 }}>{safe.name}</p>
      <p style={{ margin: "4px 0", fontSize: 20 }}>
        Tiene que haber <strong>{formatMoney(safe.balance)}</strong>
      </p>
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
        {lastCount
          ? `Último conteo: ${fmtDate(lastCount.createdAt)} (${diffText(lastCount.difference)}). Desde entonces: `
          : "Desde el primer retiro: "}
        {active.length} papelito{active.length === 1 ? "" : "s"} por {formatMoney(active.reduce((s, d) => s + d.amount, 0))}
        {withdrawals.length > 0 && `, sacaste ${formatMoney(withdrawals.reduce((s, w) => s + w.amount, 0))}`}
        {voided.length > 0 && ` · ${voided.length} retiro${voided.length === 1 ? "" : "s"} anulado${voided.length === 1 ? "" : "s"}`}.
      </p>

      {countResult && (
        <div className={Math.abs(countResult.difference) <= CLOSE_OK_TOLERANCE ? "message" : "message warning"} style={{ margin: "0 0 10px" }}>
          {countResult.difference === 0
            ? "La caja fuerte da justo."
            : countResult.difference > 0
              ? `Sobran ${formatMoney(countResult.difference)} en la caja fuerte (alguien guardó sin anotar).`
              : `Faltan ${formatMoney(-countResult.difference)} en la caja fuerte: hay papelitos sin la plata. Revisá los retiros de abajo.`}{" "}
          El saldo quedó igual a lo que contaste.
        </div>
      )}

      {mode ? (
        <div style={{ display: "grid", gap: 8, maxWidth: 360 }}>
          <input
            type="text"
            inputMode="decimal"
            autoFocus
            placeholder={mode === "count" ? "Cuánta plata contaste" : "Cuánto sacaste"}
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
          />
          <input placeholder={mode === "count" ? "Nota (opcional)" : "Para qué (ej. depósito al banco)"} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={busy} onClick={submit}>{busy ? "Guardando…" : mode === "count" ? "Comparar" : "Anotar"}</button>
            <button className="secondary" onClick={() => setMode(null)}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => { setCountResult(null); setMode("count"); }}>Contar caja fuerte</button>
          <button className="secondary" onClick={() => setMode("withdraw")}>Saqué plata</button>
          <button className="secondary" onClick={() => setShowDeposits((v) => !v)}>{showDeposits ? "Ocultar papelitos" : "Ver papelitos"}</button>
        </div>
      )}

      {showDeposits && (
        deposits.length === 0 ? (
          <p className="muted" style={{ marginTop: 10 }}>No hay retiros desde el último conteo.</p>
        ) : (
          <table className="data-table" style={{ marginTop: 10 }}>
            <thead>
              <tr><th>N.º</th><th>Cuándo</th><th>Cajera</th><th className="num">Monto</th></tr>
            </thead>
            <tbody>
              {deposits.map((d) => (
                <tr key={d.id} style={d.voidedAt ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                  <td>{d.number}</td>
                  <td>{fmtDate(d.createdAt)}</td>
                  <td>{d.employeeName ?? d.createdByName ?? "-"}{d.voidedAt ? " · anulado" : ""}</td>
                  <td className="num">{formatMoney(d.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}

export function CashControlPanel({ branchId, onMessage, adjust }: { branchId: string; onMessage: (m: string) => void; adjust: Adjust }) {
  const [open, setOpen] = useState(false);
  const [safes, setSafes] = useState<SafeAccount[]>([]);
  const [closes, setCloses] = useState<ShiftCloseRow[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([listSafeAccounts(), listPosShiftCloses(branchId, 14)]);
      setSafes(s);
      setCloses(c);
    } catch (err) {
      onMessage(err instanceof Error ? err.message : "No se pudo cargar el control de caja.");
    } finally {
      setLoading(false);
    }
  }, [branchId, onMessage]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-title">
        <h2>Control de caja</h2>
        <button className="secondary" onClick={() => setOpen((v) => !v)}>{open ? "Ocultar" : "Ver caja fuerte y cierres"}</button>
      </div>
      {!open ? (
        <p className="muted" style={{ margin: 0 }}>Cuánto tiene que haber en la caja fuerte y cómo cerró cada cajera.</p>
      ) : loading && closes.length === 0 ? (
        <p className="muted">Cargando…</p>
      ) : (
        <>
          {safes.length === 0 ? (
            <p className="muted">Todavía no hay caja fuerte: se crea sola con el primer "Guardar en caja fuerte" de Mostrador.</p>
          ) : (
            safes.map((safe) => <SafeBlock key={safe.id} safe={safe} onMessage={onMessage} adjust={adjust} onChanged={reload} />)
          )}

          <p style={{ margin: "6px 0", fontWeight: 700 }}>Últimos cierres (14 días)</p>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
            "Primer conteo" es lo que dio la primera vez que la cajera contó, antes de corregir nada.
          </p>
          {closes.length === 0 ? (
            <p className="muted">No hay turnos en estos días.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Turno</th>
                    <th>Cajera</th>
                    <th className="num">Primer conteo</th>
                    <th className="num">Al cerrar</th>
                    <th className="num">Controles</th>
                    <th className="num">A caja fuerte</th>
                    <th>Otros medios</th>
                  </tr>
                </thead>
                <tbody>
                  {closes.map((c) => {
                    const otherIssues = c.lastAccounts.filter((a) => a.difference !== null && Math.abs(a.difference) > CLOSE_OK_TOLERANCE);
                    return (
                      <tr key={c.id}>
                        <td>{fmtDate(c.openedAt)}{c.status === "open" ? " · abierto" : ""}</td>
                        <td>{c.cashierName ?? "-"}{c.cashierWithPin ? "" : <span className="muted"> (sin PIN)</span>}</td>
                        <td className={`num ${diffClass(c.firstCashDifference)}`}>{c.attempts > 0 ? diffText(c.firstCashDifference) : "-"}</td>
                        <td className={`num ${diffClass(c.difference)}`}>{diffText(c.difference)}</td>
                        <td className="num">
                          {c.attempts}
                          {c.paymentChanges > 0 && <span className="muted"> · {c.paymentChanges} venta{c.paymentChanges === 1 ? "" : "s"} corregida{c.paymentChanges === 1 ? "" : "s"}</span>}
                        </td>
                        <td className="num">{c.safeCount > 0 ? `${formatMoney(c.safeTotal)} (${c.safeCount})` : "-"}</td>
                        <td>
                          {c.lastAccounts.length === 0
                            ? <span className="muted">-</span>
                            : otherIssues.length === 0
                              ? <span className="num-positive">dan bien</span>
                              : otherIssues.map((a) => <span key={a.name} className="num-negative" style={{ display: "block" }}>{a.name}: {diffText(a.difference)}</span>)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
