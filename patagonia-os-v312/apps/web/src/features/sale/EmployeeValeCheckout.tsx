import { useState } from "react";
import type { Employee } from "@patagonia/domain";
import { formatMoney } from "../shifts/format";
import { registerEmployeeMerchandiseVale } from "../employees/employees-service";
import { valeItemsFromCart, valeTotal } from "./merchandise-vale";
import type { TicketLine } from "./sale-model";

// Vale de mercadería (migración 215): en vez de cobrar el ticket, se lo lleva un empleado. Baja el stock, no entra plata
// a la caja y se le descuenta del sueldo. Si el empleado tiene PIN de caja, lo pone él.

export interface MerchandiseValeDone {
  employeeName: string;
  amount: number;
  discountPct: number;
  cart: TicketLine[];
}

export function EmployeeValeCheckout({ cart, employees, shiftId, discountPct, disabled, onDone }: {
  cart: TicketLine[];
  employees: Employee[];
  shiftId: string | null;
  discountPct: number;
  disabled: boolean;
  onDone: (done: MerchandiseValeDone) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [pin, setPin] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const active = employees.filter((e) => e.active !== false);
  if (active.length === 0) return null;

  const lines = valeItemsFromCart(cart);
  const total = valeTotal(cart, discountPct);

  async function give() {
    setError("");
    if (!shiftId) { setError("No hay un turno abierto."); return; }
    if (!employeeId) { setError("Elegí qué empleado se lo lleva."); return; }
    if (!lines.ok) { setError(lines.problem); return; }
    setBusy(true);
    try {
      const r = await registerEmployeeMerchandiseVale({ posShiftId: shiftId, employeeId, items: lines.items, pin, detail });
      const snapshot = cart;
      setEmployeeId("");
      setPin("");
      setDetail("");
      setOpen(false);
      await onDone({ employeeName: r.employee, amount: r.amount, discountPct: r.discountPct, cart: snapshot });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo dar el vale.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div style={{ marginTop: 8, textAlign: "right" }}>
        <button className="pos-toolbar-btn" disabled={disabled} onClick={() => setOpen(true)}>Se lo lleva un empleado (vale de mercadería)</button>
      </div>
    );
  }

  return (
    <div className="pos-manual-card employee-vale-card" style={{ display: "grid", gap: 8, marginTop: 10 }}>
      <strong>Vale de mercadería</strong>
      <span className="muted" style={{ fontSize: 13 }}>
        No entra plata a la caja: el stock baja y se le descuenta del sueldo{discountPct > 0 ? `, con ${discountPct.toLocaleString("es-AR")} % de descuento para empleados` : ""}.
      </span>
      <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-label="Empleado">
        <option value="">¿Qué empleado se lo lleva?</option>
        {active.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}
      </select>
      <input type="password" inputMode="numeric" autoComplete="off" placeholder="PIN del empleado (si tiene PIN de caja)" value={pin} onChange={(e) => setPin(e.target.value)} />
      <input placeholder="Detalle (opcional)" value={detail} maxLength={120} onChange={(e) => setDetail(e.target.value)} />
      {!lines.ok && <span className="message warning" style={{ margin: 0 }}>{lines.problem}</span>}
      {error && <span className="message warning" style={{ margin: 0 }}>{error}</span>}
      <div className="row-actions" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <span>Se le descuenta del sueldo: <strong>{formatMoney(total)}</strong></span>
        <span className="row-actions">
          <button className="secondary" disabled={busy} onClick={() => { setOpen(false); setError(""); }}>Cancelar</button>
          <button disabled={busy || disabled || !lines.ok} onClick={() => void give()}>{busy ? "Guardando…" : "Dar el vale"}</button>
        </span>
      </div>
    </div>
  );
}
