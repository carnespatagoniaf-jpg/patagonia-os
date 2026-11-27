import { useEffect, useRef, useState } from "react";
import type { Employee } from "@patagonia/domain";
import { formatMoney } from "../shifts/format";
import { registerEmployeeMerchandiseVale } from "../employees/employees-service";
import { valeItemsFromCart, valeTotal } from "./merchandise-vale";
import type { TicketLine } from "./sale-model";

// Forma de pago "Empleado" (vale de mercadería, migración 215): en vez de cobrar el ticket, se lo lleva un empleado.
// Baja el stock, no entra plata a la caja y se le descuenta del sueldo. Lo más corto posible: elegir quién y "Dar vale".
// El PIN aparece solo si ese empleado tiene PIN de caja (lo dice la base al intentar).

export interface MerchandiseValeDone {
  employeeName: string;
  amount: number;
  discountPct: number;
  cart: TicketLine[];
}

const needsPinError = (msg: string) => /PIN/i.test(msg);

export function EmployeeValePanel({ cart, employees, shiftId, discountPct, disabled, onDone }: {
  cart: TicketLine[];
  employees: Employee[];
  shiftId: string | null;
  discountPct: number;
  disabled: boolean;
  onDone: (done: MerchandiseValeDone) => Promise<void> | void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [pin, setPin] = useState("");
  const [needsPin, setNeedsPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectRef = useRef<HTMLSelectElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const giveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => selectRef.current?.focus(), []);
  useEffect(() => {
    if (needsPin) pinRef.current?.focus();
  }, [needsPin]);

  const active = employees.filter((e) => e.active !== false);
  const lines = valeItemsFromCart(cart);
  const total = valeTotal(cart, discountPct);

  async function give() {
    if (busy) return;
    setError("");
    if (!shiftId) { setError("No hay un turno abierto."); return; }
    if (!employeeId) { setError("Elegí qué empleado se lo lleva."); selectRef.current?.focus(); return; }
    if (!lines.ok) { setError(lines.problem); return; }
    setBusy(true);
    try {
      const r = await registerEmployeeMerchandiseVale({ posShiftId: shiftId, employeeId, items: lines.items, pin });
      await onDone({ employeeName: r.employee, amount: r.amount, discountPct: r.discountPct, cart });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "No se pudo dar el vale.";
      if (needsPinError(msg)) setNeedsPin(true);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="pos-payment-row" style={{ flexWrap: "wrap" }}>
        <select
          ref={selectRef}
          aria-label="Empleado"
          value={employeeId}
          onChange={(e) => { setEmployeeId(e.target.value); setNeedsPin(false); setPin(""); setError(""); requestAnimationFrame(() => giveRef.current?.focus()); }}
        >
          <option value="">¿Qué empleado se lo lleva?</option>
          {active.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
        </select>
        {needsPin && (
          <input
            ref={pinRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="PIN del empleado"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void give(); } }}
          />
        )}
      </div>
      <p className="muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
        No entra plata a la caja: el stock baja y se le descuenta del sueldo{discountPct > 0 ? ` (con ${discountPct.toLocaleString("es-AR")} % de descuento)` : ""}.
      </p>
      {(error || !lines.ok) && <p className="message warning" style={{ margin: "8px 0 0" }}>{error || (!lines.ok ? lines.problem : "")}</p>}
      <div className="pos-total-bar" style={{ marginTop: 12 }}>
        <div>
          <p className="pos-total-label">Se le descuenta del sueldo</p>
          <strong className="pos-total-value">{formatMoney(total)}</strong>
        </div>
        <button
          ref={giveRef}
          className="charge-button pos-charge-btn"
          disabled={busy || disabled || !lines.ok}
          onClick={() => void give()}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void give(); } }}
        >
          {busy ? "Guardando…" : (<>Dar vale <kbd>Enter</kbd></>)}
        </button>
      </div>
    </>
  );
}
