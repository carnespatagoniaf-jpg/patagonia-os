import { useEffect, useRef, useState } from "react";
import type { Product } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import type { ScaleConfig } from "./scale-barcode";
import { compareScaleControl, describeScaleTicket, type ScaleComparison, type ScannedScaleTicket } from "./scale-control";
import { getScaleControl, listScaleVoids, saveScaleControl, voidScaleTicket, type ScaleControlState, type ScaleVoid } from "./scale-control-service";
import type { PosShift } from "./pos-shift-service";
import { quantityNumber } from "./quantity";

/**
 * Control de la balanza que imprime tickets (migración 104):
 * - ScaleVoidForm: "Anular ticket de balanza" — el ticket que salió mal se
 *   escanea y queda registrado (quién, cuándo, cuánto) en vez de tirarlo.
 * - ScaleCloseControl: en el cierre, se cargan los números del "TOTAL DEL
 *   DIA" de la balanza y se comparan con lo cobrado en Mostrador.
 */

const kg = (n: number) => `${n.toLocaleString("es-AR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`;
const time = (iso: string) => new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

export function ScaleVoidForm({ visible, shift, products, scaleConfig, onMessage, onClose }: {
  visible: boolean;
  shift: PosShift;
  products: Product[];
  scaleConfig: ScaleConfig;
  onMessage: (message: string) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [scanned, setScanned] = useState<ScannedScaleTicket | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [voids, setVoids] = useState<ScaleVoid[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  async function reload() {
    if (!isSupabaseConfigured) return;
    try {
      setVoids(await listScaleVoids(shift.id));
    } catch {
      // informativo
    }
  }

  useEffect(() => {
    if (!visible) return;
    void reload();
    setTimeout(() => inputRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, shift.id]);

  if (!visible) return null;

  function readCode() {
    setError("");
    const result = describeScaleTicket(code, scaleConfig, products);
    if (!result) {
      setScanned(null);
      setError("Ese código no es un ticket de la balanza (o el producto no está cargado en Stock).");
      return;
    }
    setScanned(result);
  }

  async function confirmVoid() {
    if (!scanned) return;
    if (!isSupabaseConfigured) {
      setError("En modo demostración no se guarda.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await voidScaleTicket({
        posShiftId: shift.id,
        barcode: code.trim(),
        plu: scanned.kind === "label" ? scanned.plu : null,
        productId: scanned.kind === "label" ? scanned.product.id : null,
        weightKg: scanned.kind === "label" ? scanned.weightKg : null,
        amount: scanned.amount,
        reason
      });
      onMessage(`Ticket de balanza anulado: ${formatMoney(scanned.amount)}. Guardalo junto con la caja.`);
      setCode("");
      setScanned(null);
      setReason("");
      await reload();
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo anular el ticket.");
    } finally {
      setBusy(false);
    }
  }

  const productName = (id: string | null) => products.find((p) => p.id === id)?.name ?? null;
  const voidedTotal = voids.reduce((sum, v) => sum + v.amount, 0);

  return (
    <div style={{ marginTop: 14, display: "grid", gap: 8, background: "#fff8f0", borderRadius: 12, padding: 12 }}>
      <strong>Anular ticket de balanza</strong>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Si un ticket salió mal (peso o producto equivocado), no lo tires: escanealo acá. Así el control de la balanza del cierre da bien y queda registrado quién lo anuló.
      </p>
      <input
        ref={inputRef}
        placeholder="Escaneá el ticket que salió mal"
        value={code}
        onChange={(e) => { setCode(e.target.value); setScanned(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); readCode(); } }}
      />
      {!scanned && <button className="secondary" disabled={!code.trim()} onClick={readCode}>Leer ticket</button>}
      {scanned && (
        <>
          <p style={{ margin: 0 }}>
            {scanned.kind === "total"
              ? <>Ticket de total de la balanza por <strong>{formatMoney(scanned.amount)}</strong></>
              : <><strong>{scanned.product.name}</strong>{scanned.weightKg !== null ? ` · ${kg(scanned.weightKg)}` : ""} · <strong>{formatMoney(scanned.amount)}</strong></>}
          </p>
          <input placeholder="Motivo (opcional): peso mal, producto equivocado…" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={busy} onClick={() => void confirmVoid()}>{busy ? "Anulando…" : "Anular ticket"}</button>
            <button className="secondary" onClick={() => { setScanned(null); setCode(""); }}>Otro ticket</button>
          </div>
        </>
      )}
      {error && <p className="message warning" style={{ margin: 0 }}>{error}</p>}
      {voids.length > 0 && (
        <div style={{ fontSize: 13 }}>
          <p style={{ margin: "6px 0 4px", fontWeight: 600 }}>Anulados en este turno: {voids.length} · {formatMoney(voidedTotal)}</p>
          {voids.map((v) => (
            <div key={v.id} className="muted">
              {time(v.createdAt)} · {productName(v.productId) ?? (v.plu ? `PLU ${v.plu}` : "Ticket de total")}
              {v.weightKg !== null ? ` · ${kg(v.weightKg)}` : ""} · {formatMoney(v.amount)}{v.reason ? ` · ${v.reason}` : ""}
            </div>
          ))}
        </div>
      )}
      <button className="secondary" onClick={onClose}>Cerrar</button>
    </div>
  );
}

/** Líneas de resultado (en el cierre y en el comprobante impreso). */
export function ScaleControlResult({ state, comparison }: { state: ScaleControlState; comparison: ScaleComparison }) {
  const { totals, saved } = state;
  if (!saved) return null;
  const diffText = (n: number, fmt: (x: number) => string) => (n === 0 ? "coincide ✓" : n < 0 ? `faltan ${fmt(-n)} en Mostrador` : `${fmt(n)} de más en Mostrador`);
  return (
    <div style={{ fontSize: 13, display: "grid", gap: 2 }}>
      {totals.shiftCount > 1 && <p style={{ margin: 0, color: "#8a4b00" }}>Este control abarca {totals.shiftCount} turnos (la balanza no se borró en el cierre anterior).</p>}
      <p style={{ margin: 0 }}>Balanza {formatMoney(saved.amount)} − anulados {formatMoney(totals.voidedAmount)} ({totals.voidedTickets}) = <strong>{formatMoney(comparison.expectedAmount)}</strong></p>
      <p style={{ margin: 0 }}>Cobrado en Mostrador con tickets de balanza: <strong>{formatMoney(totals.systemAmount)}</strong></p>
      <p style={{ margin: 0 }}>
        Importe: <strong className={comparison.amountDiff < -0.99 ? "num-negative" : undefined}>{Math.abs(comparison.amountDiff) < 1 ? "coincide ✓" : diffText(Math.round(comparison.amountDiff), formatMoney)}</strong>
      </p>
      {comparison.ticketsDiff !== null && (
        <p style={{ margin: 0 }}>
          Tickets: balanza {saved.tickets} − {totals.voidedTickets} anulados = {comparison.expectedTickets} · Mostrador {totals.systemTickets} ·{" "}
          <strong className={comparison.ticketsDiff < 0 ? "num-negative" : undefined}>{diffText(comparison.ticketsDiff, (n) => `${n} ticket${n === 1 ? "" : "s"}`)}</strong>
        </p>
      )}
      {comparison.kgDiff !== null && (
        <p style={{ margin: 0 }}>
          Kilos: balanza {kg(saved.kg ?? 0)} − {kg(totals.voidedKg)} anulados · Mostrador {kg(totals.systemKg)} ·{" "}
          <strong>{Math.abs(comparison.kgDiff) < 0.005 ? "coincide ✓" : diffText(comparison.kgDiff, kg)}</strong>
        </p>
      )}
      {!saved.cleared && <p style={{ margin: 0, color: "#8a4b00" }}>No se borró la balanza: el próximo control va a sumar este turno.</p>}
    </div>
  );
}

export function ScaleCloseControl({ shift, onStatusChange }: {
  shift: PosShift;
  /** needed: el turno tuvo tickets de balanza o anulados; saved: ya se cargó el control. */
  onStatusChange: (status: { needed: boolean; saved: boolean }) => void;
}) {
  const [state, setState] = useState<ScaleControlState | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [kgInput, setKgInput] = useState("");
  const [ticketsInput, setTicketsInput] = useState("");
  const [cleared, setCleared] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isSupabaseConfigured) {
      // Modo demostración: se puede probar la cuenta, sin guardar nada.
      setState({ totals: { systemAmount: 0, systemKg: 0, systemTickets: 0, voidedAmount: 0, voidedKg: 0, voidedTickets: 0, shiftCount: 1 }, saved: null });
      return;
    }
    void getScaleControl(shift.id)
      .then((s) => {
        setState(s);
        onStatusChange({ needed: s.totals.systemTickets > 0 || s.totals.voidedTickets > 0, saved: Boolean(s.saved) });
      })
      .catch(() => {
        // Base sin la migración 104 o sin conexión: el cierre sigue igual que antes.
        onStatusChange({ needed: false, saved: false });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shift.id]);

  if (!state) return null;

  async function save() {
    const amount = parseAmount(amountInput);
    if (!amountInput.trim() || !Number.isFinite(amount) || amount < 0) {
      setError("Cargá el TOTAL DE VENTAS que imprimió la balanza.");
      return;
    }
    const kgValue = kgInput.trim() ? quantityNumber(kgInput) : null;
    const ticketsValue = ticketsInput.trim() ? Number(ticketsInput) : null;
    if ((kgValue !== null && !Number.isFinite(kgValue)) || (ticketsValue !== null && !Number.isInteger(ticketsValue))) {
      setError("Revisá los kilos y la cantidad de tickets.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!isSupabaseConfigured) {
        setState((current) => current && { ...current, saved: { amount, kg: kgValue, tickets: ticketsValue, cleared, savedAt: new Date().toISOString() } });
        return;
      }
      const next = await saveScaleControl(shift.id, { amount, kg: kgValue, tickets: ticketsValue }, cleared);
      setState(next);
      onStatusChange({ needed: true, saved: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el control.");
    } finally {
      setBusy(false);
    }
  }

  const comparison = state.saved ? compareScaleControl(state.saved, state.totals) : null;

  return (
    <div style={{ background: "#f8f9fb", borderRadius: 12, padding: 12, marginBottom: 10, display: "grid", gap: 8 }}>
      <strong>Control de la balanza</strong>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Imprimí el "TOTAL DEL DIA" de la balanza y copiá acá los números. Se comparan con lo cobrado en Mostrador con tickets de la balanza
        {state.totals.shiftCount > 1 ? ` (abarca ${state.totals.shiftCount} turnos: la balanza no se borró en el cierre anterior)` : ""}.
      </p>
      {comparison && state.saved ? (
        <>
          <ScaleControlResult state={state} comparison={comparison} />
          <button className="secondary" onClick={() => { setState({ ...state, saved: null }); onStatusChange({ needed: true, saved: false }); }}>Corregir los números</button>
        </>
      ) : (
        <>
          <label className="muted" style={{ fontSize: 13 }}>Total de ventas $
            <input type="text" inputMode="decimal" placeholder="0" value={amountInput} onChange={(e) => setAmountInput(e.target.value)} />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label className="muted" style={{ fontSize: 13 }}>Total de peso (kg)
              <input type="text" inputMode="decimal" placeholder="opcional" value={kgInput} onChange={(e) => setKgInput(e.target.value)} />
            </label>
            <label className="muted" style={{ fontSize: 13 }}>Tiques emitidos
              <input type="number" step="1" min="0" placeholder="opcional" value={ticketsInput} onChange={(e) => setTicketsInput(e.target.value)} />
            </label>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={cleared} onChange={(e) => setCleared(e.target.checked)} />
            Ya borré el total de la balanza
          </label>
          <button disabled={busy} onClick={() => void save()}>{busy ? "Comparando…" : "Comparar"}</button>
        </>
      )}
      {error && <p className="message warning" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
