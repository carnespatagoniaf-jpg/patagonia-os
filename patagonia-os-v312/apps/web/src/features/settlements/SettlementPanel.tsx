import { useEffect, useMemo, useState } from "react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useActiveBranch } from "../branches/BranchProvider";
import { addDaysIso, formatMoney, todayIso } from "../shifts/format";
import { cardFeeMonths, feeLooksWrong, settle, upcomingByDay, type AccountSettlement } from "./settlement";
import {
  bookCardFees,
  loadSettlementData,
  setAccountSettlement,
  undoCardFeeBooking,
  type SettlementAccountRow,
  type SettlementData
} from "./settlement-service";

/**
 * Tesorería → "Plata por entrar" (migración 167, plan Full, dueño/admin).
 * Lo cobrado con posnet, QR o transferencia que todavía no llegó al banco,
 * cuándo llega, qué está atrasado y las comisiones de tarjetas del mes.
 */

const DAYS_BACK = 90;
const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

function dayLabel(iso: string, today: string): string {
  if (iso === today) return "Hoy";
  if (iso === addDaysIso(today, 1)) return "Mañana";
  const d = new Date(`${iso}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

const shortDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;
const pct = (n: number) => `${String(n).replace(".", ",")}%`;

interface Draft {
  instant: boolean;
  days: string;
  fee: string;
}

function draftOf(r: SettlementAccountRow): Draft {
  return { instant: r.days === 0, days: r.days && r.days > 0 ? String(r.days) : "", fee: r.feePct ? String(r.feePct).replace(".", ",") : "" };
}

export function SettlementPanel({ totalBalance, onLedgerChanged }: { totalBalance: number; onLedgerChanged: () => void }) {
  const { branchId } = useActiveBranch();
  const today = todayIso();
  const [data, setData] = useState<SettlementData | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  async function reload() {
    try {
      const d = await loadSettlementData(addDaysIso(today, -DAYS_BACK));
      setData(d);
      setDrafts(Object.fromEntries(d.rows.map((r) => [r.id, draftOf(r)])));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la plata por entrar.");
    }
  }

  useEffect(() => {
    if (isSupabaseConfigured) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const result: AccountSettlement[] = useMemo(
    () => (data ? settle({ accounts: data.accounts, sales: data.sales, cardCredits: data.cardCredits, coverage: data.coverage, today }) : []),
    [data, today]
  );
  const months = useMemo(
    () => (data ? cardFeeMonths({ accounts: data.accounts, sales: data.sales, cardCredits: data.cardCredits, coverage: data.coverage, today }) : []),
    [data, today]
  );

  if (!isSupabaseConfigured) return null;

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      setMessage(done);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  function saveTerms(row: SettlementAccountRow) {
    const d = drafts[row.id];
    if (!d) return;
    const days = d.instant ? 0 : Number(d.days.trim());
    // Un % se escribe "3,5" o "3.5": no es plata, el punto no es de miles.
    const fee = d.fee.trim() ? Number(d.fee.trim().replace(",", ".")) : 0;
    if (!d.instant && (!Number.isInteger(days) || days < 1 || days > 60)) {
      setMessage(`${row.name}: poné cuántos días hábiles tarda (1 a 60), o tildá "Llega en el momento".`);
      return;
    }
    if (!Number.isFinite(fee) || fee < 0 || fee > 30) {
      setMessage(`${row.name}: el % que te descuentan tiene que ser de 0 a 30.`);
      return;
    }
    void run(() => setAccountSettlement(row.id, days, fee), `Listo: guardamos las condiciones de ${row.name}.`);
  }

  if (error) return <section className="panel" style={{ marginTop: 18 }}><div className="message warning">{error}</div></section>;
  if (!data) return null;

  const configured = data.rows.filter((r) => r.days !== null);
  const pendingGross = result.reduce((s, r) => s + r.pendingGross, 0);
  const pendingNet = result.reduce((s, r) => s + r.pendingNet, 0);
  const lateGross = result.reduce((s, r) => s + r.lateGross, 0);
  const lateLots = result.flatMap((r) => r.lots.filter((l) => l.status === "atrasado").map((l) => ({ ...l, name: r.account.name })));
  const upcoming = upcomingByDay(result, today).slice(0, 7);
  const wrongFees = result.filter(feeLooksWrong);
  const booked = new Map(data.feeBookings.map((b) => [`${b.reconId}|${b.month}`, b]));
  const feeRows = months.slice(-3).map((m) => ({ ...m, booking: booked.get(`${m.reconId}|${m.month}`) ?? null }));
  const assumedAccounts = result.filter((r) => r.lots.some((l) => l.assumed && l.status !== "entro") || (!r.account.reconId && r.lots.length > 0));

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-title">
        <h2>Plata por entrar</h2>
        <button className="secondary" onClick={() => setShowTerms((v) => !v)}>
          {showTerms ? "Cerrar condiciones" : configured.length === 0 ? "Cargar condiciones" : "Condiciones de cada cuenta"}
        </button>
      </div>
      {message && <div className="message">{message}</div>}

      {configured.length === 0 && !showTerms ? (
        <p className="muted" style={{ margin: 0 }}>
          Lo que cobrás con posnet o Mercado Pago no llega al banco en el momento: tarda unos días y llega con la comisión descontada.
          Cargá cuántos días tarda cada cuenta y qué % te descuentan, y acá vas a ver cuánta plata tenés de verdad hoy, cuánta está por llegar y si algo se atrasó.
        </p>
      ) : (
        configured.length > 0 && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <span>Disponible hoy</span>
                <strong>{formatMoney(totalBalance - pendingGross)}</strong>
                <small>Saldos de Tesorería menos lo que todavía no llegó</small>
              </div>
              <div className="kpi-card">
                <span>Por entrar</span>
                <strong>{formatMoney(pendingNet)}</strong>
                <small>Vendiste {formatMoney(pendingGross)}; llega con la comisión descontada</small>
              </div>
              {lateGross > 0 && (
                <div className="kpi-card">
                  <span>Atrasado</span>
                  <strong style={{ color: "var(--danger)" }}>{formatMoney(lateGross)}</strong>
                  <small>Tenía que estar en el banco y no está en el resumen</small>
                </div>
              )}
            </div>

            {upcoming.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <p style={{ margin: "0 0 6px", fontWeight: 700 }}>Lo que va a entrar</p>
                <p style={{ margin: 0 }}>
                  {upcoming.map((u) => (
                    <span key={u.date} className="badge brand" style={{ marginRight: 6, marginBottom: 6 }}>
                      {dayLabel(u.date, today)}: {formatMoney(u.net)}
                    </span>
                  ))}
                </p>
              </div>
            )}

            {lateLots.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <p style={{ margin: "0 0 6px", fontWeight: 700 }}>Atrasado: revisalo con el banco o la procesadora</p>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead><tr><th>Cuenta</th><th>Vendido el</th><th>Tenía que entrar</th><th className="num">Falta</th></tr></thead>
                    <tbody>
                      {lateLots.slice(0, 15).map((l) => (
                        <tr key={`${l.accountId}|${l.saleDate}`}>
                          <td>{l.name}</td>
                          <td>{shortDate(l.saleDate)}</td>
                          <td>{shortDate(l.expectedDate)}</td>
                          <td className="num">{formatMoney(l.pendingGross)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {lateLots.length > 15 && <p className="muted" style={{ fontSize: 12 }}>Y {lateLots.length - 15} días más.</p>}
              </div>
            )}

            {wrongFees.map((r) => (
              <div key={r.account.id} className="message warning" style={{ marginTop: 14 }}>
                <strong>{r.account.name}:</strong> según el resumen del banco te están descontando {pct(r.realFeePct!)}, y cargaste {pct(r.account.feePct)}.{" "}
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void run(() => setAccountSettlement(r.account.id, r.account.days, r.realFeePct!), `Listo: ${r.account.name} ahora descuenta ${pct(r.realFeePct!)}.`)}
                >
                  Usar {pct(r.realFeePct!)}
                </button>
              </div>
            ))}

            {feeRows.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <p style={{ margin: "0 0 6px", fontWeight: 700 }}>Comisiones de tarjetas del mes</p>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead><tr><th>Mes</th><th>Cuenta del banco</th><th className="num">Tenía que entrar</th><th className="num">Entró</th><th className="num">Te descontaron</th><th></th></tr></thead>
                    <tbody>
                      {feeRows.map((m) => (
                        <tr key={`${m.reconId}|${m.month}`}>
                          <td>{monthLabel(m.month)}</td>
                          <td>{data.reconNames[m.reconId] ?? "Banco"}</td>
                          <td className="num">{formatMoney(m.expected)}</td>
                          <td className="num">{formatMoney(m.credited)}</td>
                          <td className="num">{formatMoney(m.fee)} ({pct(m.feePct)})</td>
                          <td>
                            {m.booking ? (
                              <div className="row-actions">
                                <span className="badge ok">Anotado</span>
                                <button
                                  className="secondary"
                                  disabled={busy}
                                  onClick={() => {
                                    if (!window.confirm(`¿Borrar el gasto de comisiones de ${monthLabel(m.month)}?`)) return;
                                    void run(async () => { await undoCardFeeBooking(m.booking!.id); onLedgerChanged(); }, "Listo: se borró el gasto de comisiones.");
                                  }}
                                >
                                  Deshacer
                                </button>
                              </div>
                            ) : (
                              <button
                                disabled={busy || !branchId}
                                onClick={() => void run(async () => { await bookCardFees(m.reconId, m.month, m.fee, branchId!); onLedgerChanged(); }, `Listo: anotamos ${formatMoney(m.fee)} de comisiones de ${monthLabel(m.month)} como gasto.`)}
                              >
                                Anotar como gasto
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                  Sale del resumen del banco: lo vendido con posnet que tenía que entrar ese mes, menos lo que entró. Al anotarlo, Tesorería queda igual que el banco.
                </p>
              </div>
            )}

            {assumedAccounts.length > 0 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
                {assumedAccounts.map((r) => r.account.name).join(", ")}: no hay resumen del banco que lo confirme, así que suponemos que llegó el día previsto.
                Subí el resumen en Conciliación para saber si de verdad entró.
              </p>
            )}
          </>
        )
      )}

      {showTerms && (
        <div className="form-box" style={{ marginTop: 14 }}>
          <p style={{ margin: "0 0 4px", fontWeight: 700 }}>¿Cuánto tarda y cuánto te descuentan?</p>
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
            Lo dice el contrato con tu banco, la procesadora del posnet o Mercado Pago. Si no lo sabés, poné algo aproximado: cuando subas el resumen del banco te avisamos cuánto te descuentan de verdad.
            Por ejemplo: débito 1 día hábil y 1,5%; crédito en un pago 2 a 10 días y 3%; transferencias, en el momento y 0%.
          </p>
          {data.rows.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No tenés cuentas que no sean efectivo.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Cuenta</th><th>Llega en el momento</th><th>Días hábiles</th><th>% que te descuentan</th><th></th></tr></thead>
                <tbody>
                  {data.rows.map((r) => {
                    const d = drafts[r.id] ?? draftOf(r);
                    const set = (patch: Partial<Draft>) => setDrafts((prev) => ({ ...prev, [r.id]: { ...d, ...patch } }));
                    return (
                      <tr key={r.id}>
                        <td>
                          {r.name}
                          <span className="cell-sub">{r.reconName ? `Se confirma con el resumen de ${r.reconName}` : "Sin resumen del banco"}</span>
                        </td>
                        <td><input type="checkbox" checked={d.instant} onChange={(e) => set({ instant: e.target.checked })} /></td>
                        <td>
                          <input type="text" inputMode="numeric" disabled={d.instant} value={d.instant ? "" : d.days} placeholder="Ej. 2" onChange={(e) => set({ days: e.target.value })} style={{ width: 80 }} />
                        </td>
                        <td>
                          <input type="text" inputMode="decimal" value={d.fee} placeholder="Ej. 3,5" onChange={(e) => set({ fee: e.target.value })} style={{ width: 80 }} />
                        </td>
                        <td>
                          <div className="row-actions">
                            <button disabled={busy} onClick={() => saveTerms(r)}>Guardar</button>
                            {r.days !== null && (
                              <button className="secondary" disabled={busy} onClick={() => void run(() => setAccountSettlement(r.id, null, null), `Listo: ${r.name} ya no se sigue.`)}>
                                Quitar
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
            Para que se confirme solo, la cuenta tiene que estar en una cuenta del banco de Conciliación (y el posnet marcado como posnet). Las cuentas sin condiciones no se siguen.
          </p>
        </div>
      )}
    </section>
  );
}
