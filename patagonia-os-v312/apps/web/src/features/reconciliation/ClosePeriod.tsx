import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { parseAmount } from "../../lib/money";
import { buildClosingSheet, type ClosingSheet } from "./reconcile-match";
import { closeReconPeriod, getSystemBalance, listReconCloses, reopenReconPeriod, type ReconClose } from "./reconciliation-service";

/**
 * Cierre del período (migración 106): la planilla clásica de conciliación
 * ("saldo según el banco ± partidas pendientes = saldo según el sistema"),
 * se guarda, se imprime para el contador y lo conciliado hasta esa fecha
 * queda trabado. Lo pendiente se puede seguir conciliando después.
 */

const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n: number) => money.format(n);
const fmtDate = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");

interface Props {
  reconId: string;
  reconName: string;
  from: string;
  to: string;
  today: string;
  /** Saldo final según el propio resumen (si se pudo saber). */
  suggestedBankBalance: number | null;
  pendingBank: { total: number; count: number };
  pendingSystem: { total: number; count: number };
  cardsGap: number;
  onMessage: (message: string) => void;
  onChanged: () => void | Promise<void>;
}

interface PrintSheet {
  from: string;
  to: string;
  sheet: ClosingSheet;
  pendingBankCount: number;
  pendingSystemCount: number;
}

export function ClosePeriod(props: Props) {
  const { reconId, reconName, from, to, today } = props;
  const [bankText, setBankText] = useState("");
  const [systemBalance, setSystemBalance] = useState<number | null>(null);
  const [closes, setCloses] = useState<ReconClose[]>([]);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState<PrintSheet | null>(null);

  async function load() {
    try {
      const [balance, list] = await Promise.all([getSystemBalance(reconId, to), listReconCloses(reconId)]);
      setSystemBalance(balance);
      setCloses(list);
    } catch (err) {
      props.onMessage(err instanceof Error ? err.message : "No se pudo calcular el saldo del sistema.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconId, to]);

  useEffect(() => {
    setBankText(props.suggestedBankBalance === null ? "" : props.suggestedBankBalance.toFixed(2).replace(".", ","));
  }, [props.suggestedBankBalance, reconId, to]);

  useEffect(() => {
    if (!printing) return;
    const t = window.setTimeout(() => {
      window.print();
      setPrinting(null);
    }, 50);
    return () => window.clearTimeout(t);
  }, [printing]);

  const bankBalance = bankText.trim() === "" ? null : parseAmount(bankText);
  const sheet =
    bankBalance !== null && Number.isFinite(bankBalance) && systemBalance !== null
      ? buildClosingSheet({ bankBalance, pendingBank: props.pendingBank.total, pendingSystem: props.pendingSystem.total, cardsGap: props.cardsGap, systemBalance })
      : null;
  const alreadyClosed = closes.some((c) => c.periodEnd === to);
  const finished = to < today;

  function sheetFromClose(c: ReconClose): PrintSheet {
    const d = c.detail as Partial<ClosingSheet> & { pendingBankCount?: number; pendingSystemCount?: number };
    return {
      from: c.periodFrom,
      to: c.periodEnd,
      sheet: buildClosingSheet({
        bankBalance: c.bankBalance,
        pendingBank: Number(d.pendingBank ?? 0),
        pendingSystem: Number(d.pendingSystem ?? 0),
        cardsGap: Number(d.cardsGap ?? 0),
        systemBalance: c.systemBalance
      }),
      pendingBankCount: Number(d.pendingBankCount ?? 0),
      pendingSystemCount: Number(d.pendingSystemCount ?? 0)
    };
  }

  const current: PrintSheet | null = sheet
    ? { from, to, sheet, pendingBankCount: props.pendingBank.count, pendingSystemCount: props.pendingSystem.count }
    : null;

  return (
    <div style={{ border: "1px solid #eef0f3", borderRadius: 10, padding: 16, marginTop: 16 }}>
      <p style={{ margin: "0 0 6px", fontWeight: 700 }}>6. Cierre del período (planilla para el contador)</p>
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
        La planilla que usan las empresas: saldo según el banco, más y menos lo que todavía no cruzó, tiene que dar el saldo según el sistema. Al cerrar, lo conciliado hasta el {fmtDate(to)} queda trabado (lo pendiente se puede seguir conciliando después).
      </p>
      <label>
        Saldo que dice el banco al {fmtDate(to)}{" "}
        <input type="text" inputMode="decimal" value={bankText} onChange={(e) => setBankText(e.target.value)} style={{ width: 160 }} />
      </label>
      {props.suggestedBankBalance !== null && <span className="muted" style={{ fontSize: 12 }}> (tomado del resumen; revisalo)</span>}
      {current && <SheetTable data={current} reconName={reconName} />}
      <div className="cash-banner-form" style={{ marginTop: 10, flexWrap: "wrap" }}>
        {current && <button className="secondary" onClick={() => setPrinting(current)}>Imprimir / PDF</button>}
        <button
          disabled={busy || !sheet || alreadyClosed || !finished}
          title={!finished ? "Se cierra cuando el período ya terminó (el \"Hasta\" tiene que ser anterior a hoy)" : alreadyClosed ? "Ese período ya está cerrado" : undefined}
          onClick={async () => {
            if (!sheet || !current) return;
            if (!window.confirm(`¿Cerrar la conciliación del ${fmtDate(from)} al ${fmtDate(to)}? Lo conciliado hasta esa fecha queda trabado.`)) return;
            setBusy(true);
            try {
              await closeReconPeriod(reconId, from, to, sheet.bankBalance, {
                pendingBank: sheet.pendingBank,
                pendingSystem: sheet.pendingSystem,
                cardsGap: sheet.cardsGap,
                adjustedBank: sheet.adjustedBank,
                unexplained: sheet.unexplained,
                pendingBankCount: current.pendingBankCount,
                pendingSystemCount: current.pendingSystemCount,
                clientSystemBalance: sheet.systemBalance
              });
              props.onMessage(`Período cerrado: del ${fmtDate(from)} al ${fmtDate(to)}.`);
              await load();
              await props.onChanged();
            } catch (err) {
              props.onMessage(err instanceof Error ? err.message : "No se pudo cerrar.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {alreadyClosed ? "Período cerrado" : `Cerrar del ${fmtDate(from)} al ${fmtDate(to)}`}
        </button>
      </div>

      {closes.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Cierres anteriores ({closes.length})</summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {closes.map((c) => {
              const s = sheetFromClose(c);
              return (
                <div key={c.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 14 }}>
                  <span>
                    Del {fmtDate(c.periodFrom)} al {fmtDate(c.periodEnd)} · banco {fmt(c.bankBalance)} · sistema {fmt(c.systemBalance)} · sin explicar{" "}
                    <strong className={Math.abs(s.sheet.unexplained) < 1 ? "" : "num-negative"}>{fmt(s.sheet.unexplained)}</strong>
                  </span>
                  <button className="secondary" onClick={() => setPrinting(s)}>Imprimir</button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={async () => {
                      if (!window.confirm("¿Reabrir este cierre? Lo conciliado de ese período se va a poder cambiar de nuevo.")) return;
                      setBusy(true);
                      try {
                        await reopenReconPeriod(c.id);
                        await load();
                        await props.onChanged();
                      } catch (err) {
                        props.onMessage(err instanceof Error ? err.message : "No se pudo reabrir.");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Reabrir
                  </button>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {printing &&
        createPortal(
          <div className="print-area" style={{ padding: 24, background: "#fff" }}>
            <h2 style={{ marginTop: 0 }}>Conciliación bancaria</h2>
            <SheetTable data={printing} reconName={reconName} />
          </div>,
          document.body
        )}
    </div>
  );
}

function SheetTable({ data, reconName }: { data: PrintSheet; reconName: string }) {
  const { sheet } = data;
  const row = (label: string, value: number, strong = false) => (
    <tr>
      <td>{strong ? <strong>{label}</strong> : label}</td>
      <td className="num">{strong ? <strong>{fmt(value)}</strong> : fmt(value)}</td>
    </tr>
  );
  return (
    <div style={{ marginTop: 10, overflowX: "auto" }}>
      <p style={{ margin: "0 0 6px" }}>
        <strong>{reconName}</strong> · del {fmtDate(data.from)} al {fmtDate(data.to)}
      </p>
      <table className="data-table">
        <tbody>
          {row(`Saldo según el banco al ${fmtDate(data.to)}`, sheet.bankBalance, true)}
          {row(`− Está en el banco y no en el sistema (${data.pendingBankCount})`, -sheet.pendingBank)}
          {row(`+ Está en el sistema y no en el banco (${data.pendingSystemCount})`, sheet.pendingSystem)}
          {row("+ Tarjetas vendidas y no acreditadas / comisiones del período", sheet.cardsGap)}
          {row("= Saldo del banco ajustado", sheet.adjustedBank, true)}
          {row(`Saldo según el sistema (Tesorería) al ${fmtDate(data.to)}`, sheet.systemBalance, true)}
          <tr>
            <td><strong>Diferencia sin explicar</strong></td>
            <td className={`num ${Math.abs(sheet.unexplained) < 1 ? "num-positive" : "num-negative"}`}><strong>{fmt(sheet.unexplained)}</strong></td>
          </tr>
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
        {Math.abs(sheet.unexplained) < 1
          ? "Cierra: todo lo que hay de diferencia está explicado por las partidas de arriba."
          : "La diferencia sin explicar incluye lo que pasó antes de empezar a conciliar (saldos iniciales, meses sin resumen), comisiones de tarjetas de meses anteriores y movimientos que nunca se cargaron. Lo normal es que vaya bajando mes a mes."}
      </p>
    </div>
  );
}
