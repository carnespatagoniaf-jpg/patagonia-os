import { useMemo, useState } from "react";
import type { TreasuryAccount } from "@patagonia/domain";
import { parseAmount } from "../../lib/money";
import { isSupabaseConfigured } from "../../lib/supabase";
import { formatMoney } from "../shifts/format";
import { buildDeclared, CLOSE_OK_TOLERANCE, countIsOk, findPaymentSwaps, isOk, type CountResult, type SalePaymentRef } from "./cash-close";
import { changePosSalePaymentAccount, checkPosShiftCount, type PosCashier, type PosShift, type PosShiftSale } from "./pos-shift-service";

// Cierre de caja a ciegas (migración 117). La cajera cuenta el cajón y pone
// el total de cada posnet / transferencias SIN ver cuánto tendría que dar.
// Recién después de "Controlar" el sistema muestra la diferencia por medio de
// pago, propone ventas cobradas con el medio equivocado y pregunta si guardó
// plata en la caja fuerte sin anotarla. Cada control queda guardado: el dueño
// ve el primero aunque después se corrija.

export interface BlindCloseFormProps {
  shift: PosShift;
  /** Cuentas de cobro de Mostrador (sin la caja fuerte). */
  accounts: TreasuryAccount[];
  cashiers: PosCashier[];
  shiftSales: PosShiftSale[];
  busy: boolean;
  onSalesChanged: () => Promise<void>;
  /** Cerrar de verdad, con el efectivo contado y los totales declarados. */
  onConfirmClose: (countedCash: number, declaredAccounts: Record<string, string>) => void;
  onCancel: () => void;
  /** Cajera (sin "Control de caja"): cuenta UNA vez y se cierra; no ve cuánto tendría que dar (2026-10-28, como en
   * un supermercado). El detalle y las correcciones las ve el dueño en "Control de caja". */
  oneShot?: boolean;
}

function diffClass(diff: number | null) {
  if (diff === null) return "muted";
  if (isOk(diff)) return "num-positive";
  return "num-negative";
}

function diffLabel(diff: number | null) {
  if (diff === null) return "sin informar";
  if (Math.abs(diff) < 1) return "da justo";
  if (isOk(diff)) return `${diff > 0 ? "+" : "−"}${formatMoney(Math.abs(diff))} (da bien)`;
  return diff > 0 ? `sobra ${formatMoney(diff)}` : `falta ${formatMoney(-diff)}`;
}

export function BlindCloseForm(p: BlindCloseFormProps) {
  const cashAccount = p.accounts.find((a) => a.paymentMethod === "cash") ?? null;
  const otherAccounts = useMemo(() => p.accounts.filter((a) => a.paymentMethod !== "cash"), [p.accounts]);

  const [cashierId, setCashierId] = useState(p.shift.cashierEmployeeId ?? "");
  const [pin, setPin] = useState("");
  const [cashInput, setCashInput] = useState("");
  const [accountInputs, setAccountInputs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CountResult | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [fixingPaymentId, setFixingPaymentId] = useState<string | null>(null);

  const needsCashier = p.cashiers.length > 0;

  async function runCheck() {
    setError("");
    if (needsCashier && (!cashierId || !pin.trim())) {
      setError("Elegí quién cierra la caja y poné su PIN.");
      return;
    }
    const built = buildDeclared({ cash: cashInput, accounts: accountInputs }, otherAccounts.map((a) => a.id), parseAmount);
    if ("error" in built) {
      setError(built.error);
      return;
    }
    if (!isSupabaseConfigured) {
      // Modo demo: sin servidor no hay control, se cierra con lo contado.
      p.onConfirmClose(built.payload.cash, accountInputs);
      return;
    }
    setChecking(true);
    try {
      const cashier = needsCashier ? { employeeId: cashierId, pin: pin.trim() } : null;
      const checked = await checkPosShiftCount(p.shift.id, built.payload, cashier);
      if (p.oneShot) {
        p.onConfirmClose(checked.cashDeclared, Object.fromEntries(checked.accounts.filter((r) => r.declared !== null).map((r) => [r.accountId, String(r.declared)])));
        return;
      }
      setResult(checked);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo controlar la caja.");
    } finally {
      setChecking(false);
    }
  }

  const payments: SalePaymentRef[] = useMemo(
    () =>
      p.shiftSales
        .filter((s) => !s.voidedAt)
        .flatMap((s) =>
          s.payments
            .filter((pay) => pay.id && pay.accountId)
            .map((pay) => ({ saleId: s.id, paymentId: pay.id!, accountId: pay.accountId!, amount: pay.amount, createdAt: s.createdAt }))
        ),
    [p.shiftSales]
  );

  const swaps = useMemo(
    () => (result ? findPaymentSwaps(result, payments, { accountId: cashAccount?.id ?? null, name: cashAccount?.name ?? "Efectivo" }) : []),
    [result, payments, cashAccount]
  );

  async function fixPayment(paymentId: string, toAccountId: string) {
    setError("");
    setFixingPaymentId(paymentId);
    try {
      await changePosSalePaymentAccount(paymentId, toAccountId);
      await p.onSalesChanged();
      await runCheck();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo corregir el medio de pago.");
    } finally {
      setFixingPaymentId(null);
    }
  }

  function confirmClose() {
    if (!result) return;
    if (!countIsOk(result)) {
      const lines = [`Efectivo: ${diffLabel(result.cashDifference)}`, ...result.accounts.map((r) => `${r.name}: ${diffLabel(r.difference)}`)];
      if (!window.confirm(`La caja NO da bien:\n\n${lines.join("\n")}\n\n¿Cerrar el turno igual? El dueño va a ver esta diferencia.`)) return;
    }
    p.onConfirmClose(result.cashDeclared, Object.fromEntries(result.accounts.filter((r) => r.declared !== null).map((r) => [r.accountId, String(r.declared)])));
  }

  if (!result) {
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <p style={{ margin: 0, fontWeight: 700 }}>Cerrar la caja</p>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Contá los billetes del cajón y copiá el total de cada posnet y de las transferencias. El sistema no te dice cuánto tendría que dar hasta que pongas lo que contaste.
        </p>
        {needsCashier && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select value={cashierId} onChange={(e) => setCashierId(e.target.value)}>
              <option value="">¿Quién cierra?</option>
              {p.cashiers.map((c) => (
                <option key={c.employeeId} value={c.employeeId}>{c.fullName}</option>
              ))}
            </select>
            <input type="password" inputMode="numeric" maxLength={6} placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} style={{ width: 90 }} />
          </div>
        )}
        <label className="muted" style={{ fontSize: 13 }}>
          Plata en el cajón (efectivo) $
          <input type="text" inputMode="decimal" placeholder="Contá los billetes" value={cashInput} onChange={(e) => setCashInput(e.target.value)} style={{ display: "block", width: "100%", marginTop: 4 }} />
        </label>
        {otherAccounts.map((a) => (
          <label key={a.id} className="muted" style={{ fontSize: 13 }}>
            Total de {a.name} $
            <input
              type="text"
              inputMode="decimal"
              placeholder="Del ticket de cierre del posnet o de los comprobantes (0 si no hubo)"
              value={accountInputs[a.id] ?? ""}
              onChange={(e) => setAccountInputs({ ...accountInputs, [a.id]: e.target.value })}
              style={{ display: "block", width: "100%", marginTop: 4 }}
            />
          </label>
        ))}
        {error && <p className="num-negative" style={{ margin: 0 }}>{error}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button disabled={checking || p.busy} onClick={runCheck}>{checking || p.busy ? "Cerrando…" : p.oneShot ? "Cerrar caja" : "Controlar"}</button>
          <button className="secondary" onClick={p.onCancel}>Cancelar</button>
        </div>
      </div>
    );
  }

  const ok = countIsOk(result);
  // Ya no se ofrece "Sí, anotar el retiro" después de ver la diferencia: convertía un faltante en un papelito sin
  // que nadie lo viera (auditoría 29/10/2026, crítico C7). Un retiro se anota cuando se saca la plata.

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className={ok ? "message" : "message warning"} style={{ margin: 0 }}>
        <strong>{ok ? "La caja da bien." : "La caja no da."}</strong>
        {result.attempt > 1 && (
          <span className="muted" style={{ display: "block", fontSize: 12 }}>
            Control N.º {result.attempt}. El primer conteo dio {diffLabel(result.firstCashDifference)} en efectivo y quedó guardado.
          </span>
        )}
      </div>

      <table className="data-table">
        <thead>
          <tr><th></th><th className="num">Contaste</th><th className="num">Sistema</th><th className="num">Diferencia</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Efectivo</td>
            <td className="num">{formatMoney(result.cashDeclared)}</td>
            <td className="num">{formatMoney(result.cashExpected)}</td>
            <td className={`num ${diffClass(result.cashDifference)}`}><strong>{diffLabel(result.cashDifference)}</strong></td>
          </tr>
          {result.accounts.map((r) => (
            <tr key={r.accountId}>
              <td>{r.name}</td>
              <td className="num">{r.declared === null ? "-" : formatMoney(r.declared)}</td>
              <td className="num">{formatMoney(r.expected)}</td>
              <td className={`num ${diffClass(r.difference)}`}><strong>{diffLabel(r.difference)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Efectivo del sistema: fondo {formatMoney(result.openingCash)} + ventas en efectivo {formatMoney(result.cashSales)}
        {result.cashMovements !== 0 && ` ${result.cashMovements < 0 ? "−" : "+"} retiros, vales y pagos ${formatMoney(Math.abs(result.cashMovements))}`}.
      </p>

      {swaps.map((swap) => (
        <div key={`${swap.fromAccountId}-${swap.toAccountId}`} className="panel" style={{ padding: 12 }}>
          <p style={{ margin: "0 0 6px" }}>
            Falta {formatMoney(swap.amount)} en <strong>{swap.fromName}</strong> y sobra casi lo mismo en <strong>{swap.toName}</strong>: seguramente una venta se marcó con el medio de pago equivocado.
          </p>
          {swap.candidates.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>No hay una venta de ese monto exacto; puede ser más de una. Revisalas en "Ver movimientos".</p>
          ) : (
            swap.candidates.slice(0, 4).map((c) => (
              <div key={c.paymentId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
                <span>Venta de las {new Date(c.createdAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })} por {formatMoney(c.amount)}</span>
                <button className="secondary" disabled={fixingPaymentId !== null} onClick={() => fixPayment(c.paymentId, swap.toAccountId)}>
                  {fixingPaymentId === c.paymentId ? "Corrigiendo…" : `Pasarla a ${swap.toName}`}
                </button>
              </div>
            ))
          )}
        </div>
      ))}

      {error && <p className="num-negative" style={{ margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button disabled={p.busy} onClick={confirmClose}>{p.busy ? "Cerrando…" : ok ? "Cerrar caja" : "Cerrar igual con diferencia"}</button>
        <button className="secondary" onClick={() => setResult(null)}>Volver a contar</button>
        <button className="secondary" onClick={p.onCancel}>Cancelar</button>
      </div>
    </div>
  );
}
