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
import { hasPosVoidPin, listPosVoidedSales, setPosVoidPin, type VoidedSale } from "./pos-shift-service";
import { delayLabel, isValidAuthPin, minutesBetween } from "./void-sale";

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

// PIN de autorización para anular ventas (149). Para cambiarlo o sacarlo hay
// que saber el actual: las cajeras suelen usar el mismo usuario que el dueño.
function VoidPinBlock({ onMessage, onChange }: { onMessage: (m: string) => void; onChange: (hasPin: boolean) => void }) {
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void hasPosVoidPin().then(setHasPin).catch(() => setHasPin(null));
  }, []);

  async function save(remove: boolean) {
    setError("");
    if (!remove && !isValidAuthPin(next)) {
      setError("El PIN nuevo tiene que ser de 4 a 6 números.");
      return;
    }
    if (hasPin && !current.trim()) {
      setError("Poné el PIN actual.");
      return;
    }
    setBusy(true);
    try {
      const result = await setPosVoidPin(hasPin ? current.trim() : null, remove ? null : next.trim());
      if (!result.ok) {
        setError(result.error ?? "No se pudo guardar.");
        return;
      }
      setHasPin(!remove);
      onChange(!remove);
      setEditing(false);
      setCurrent("");
      setNext("");
      onMessage(remove ? "PIN para anular sacado: cualquiera puede anular (con motivo)." : "PIN para anular guardado. Desde ahora anular una venta lo pide.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  const pinInput = (value: string, set: (v: string) => void, placeholder: string) => (
    <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} placeholder={placeholder} value={value} onChange={(e) => set(e.target.value.replace(/\D/g, ""))} />
  );

  return (
    <div className="panel" style={{ padding: "10px 14px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>PIN para anular ventas:</span>
        <span className={hasPin === false ? "num-negative" : "muted"} style={{ fontSize: 13, flex: 1, minWidth: 180 }}>
          {hasPin === null ? "cargando…" : hasPin ? "activado (no se lo des a las cajeras)" : "sin PIN, cualquiera puede anular"}
        </span>
        {!editing && hasPin !== null && (
          <button className="secondary" onClick={() => setEditing(true)}>{hasPin ? "Cambiar PIN" : "Poner PIN"}</button>
        )}
      </div>
      {editing && (
        <div style={{ display: "grid", gap: 8, maxWidth: 320, marginTop: 10 }}>
          {hasPin && pinInput(current, setCurrent, "PIN actual")}
          {pinInput(next, setNext, hasPin ? "PIN nuevo (4 a 6 números)" : "PIN (4 a 6 números)")}
          {error && <p style={{ color: "#a52424", margin: 0 }}>{error}</p>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button disabled={busy} onClick={() => void save(false)}>{busy ? "Guardando…" : "Guardar"}</button>
            {hasPin && <button className="secondary" disabled={busy} onClick={() => void save(true)}>Sacar PIN</button>}
            <button className="secondary" onClick={() => { setEditing(false); setError(""); }}>Cancelar</button>
          </div>
          {hasPin && <p className="muted" style={{ margin: 0, fontSize: 12 }}>¿Te lo olvidaste? Pedí a soporte que lo borre.</p>}
        </div>
      )}
    </div>
  );
}

const VOIDED_PREVIEW = 5;

function VoidedSalesBlock({ sales }: { sales: VoidedSale[] }) {
  const [showAll, setShowAll] = useState(false);
  const total = sales.reduce((sum, s) => sum + s.total, 0);
  const late = sales.filter((s) => minutesBetween(s.soldAt, s.voidedAt) >= 10).length;
  const visible = showAll ? sales : sales.slice(0, VOIDED_PREVIEW);
  return (
    <>
      <p style={{ margin: "6px 0", fontWeight: 700 }}>Ventas anuladas (14 días)</p>
      <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
        {sales.length === 0
          ? "No se anuló ninguna venta en estos días."
          : `${sales.length} por ${formatMoney(total)}.`}
        {late > 0 && <span className="num-negative"> {late} se anul{late === 1 ? "ó" : "aron"} 10 minutos o más después de venderse: revisalas.</span>}
      </p>
      {sales.length > 0 && (
        <div style={{ overflowX: "auto", marginBottom: 14 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Vendida</th>
                <th>Anulada</th>
                <th className="num">Monto</th>
                <th>Motivo</th>
                <th>Cajera</th>
                <th>Con PIN</th>
                <th>Qué era</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => {
                const late = minutesBetween(s.soldAt, s.voidedAt) >= 10;
                return (
                  <tr key={s.id}>
                    <td>{fmtDate(s.soldAt)}</td>
                    <td className={late ? "num-negative" : undefined}>{delayLabel(minutesBetween(s.soldAt, s.voidedAt))}</td>
                    <td className="num">{formatMoney(s.total)}</td>
                    <td>{s.reason ?? <span className="muted">sin motivo (antes del cambio)</span>}</td>
                    <td>{s.cashierName ?? s.voidedByName ?? "-"}</td>
                    <td>{s.authorized ? "Sí" : <span className="muted">No</span>}</td>
                    <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.items ?? ""}>{s.items ?? "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sales.length > VOIDED_PREVIEW && (
            <button className="secondary" style={{ marginTop: 8 }} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Ver menos" : `Ver las ${sales.length}`}
            </button>
          )}
        </div>
      )}
    </>
  );
}

export function CashControlPanel({ branchId, onMessage, adjust, onVoidPinChange, refreshKey }: {
  branchId: string;
  onMessage: (m: string) => void;
  adjust: Adjust;
  onVoidPinChange: (hasPin: boolean) => void;
  /** Cambia cuando se anula una venta del turno, para recargar la lista. */
  refreshKey: number;
}) {
  const [open, setOpen] = useState(false);
  const [safes, setSafes] = useState<SafeAccount[]>([]);
  const [closes, setCloses] = useState<ShiftCloseRow[]>([]);
  const [voided, setVoided] = useState<VoidedSale[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [s, c, v] = await Promise.all([listSafeAccounts(), listPosShiftCloses(branchId, 14), listPosVoidedSales(branchId, 14).catch(() => [])]);
      setSafes(s);
      setCloses(c);
      setVoided(v);
    } catch (err) {
      onMessage(err instanceof Error ? err.message : "No se pudo cargar el control de caja.");
    } finally {
      setLoading(false);
    }
  }, [branchId, onMessage]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload, refreshKey]);

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-title">
        <h2>Control de caja</h2>
        <button className="secondary" onClick={() => setOpen((v) => !v)}>{open ? "Ocultar" : "Ver caja fuerte, anuladas y cierres"}</button>
      </div>
      {!open ? (
        <p className="muted" style={{ margin: 0 }}>Cuánto tiene que haber en la caja fuerte, las ventas anuladas y cómo cerró cada cajera.</p>
      ) : loading && closes.length === 0 ? (
        <p className="muted">Cargando…</p>
      ) : (
        <>
          {safes.length === 0 ? (
            <p className="muted">Todavía no hay caja fuerte: se crea sola con el primer "Guardar en caja fuerte" de Mostrador.</p>
          ) : (
            safes.map((safe) => <SafeBlock key={safe.id} safe={safe} onMessage={onMessage} adjust={adjust} onChanged={reload} />)
          )}

          <VoidPinBlock onMessage={onMessage} onChange={onVoidPinChange} />
          <VoidedSalesBlock sales={voided} />

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
