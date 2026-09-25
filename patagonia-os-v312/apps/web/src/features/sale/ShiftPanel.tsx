import { useState } from "react";
import type { TreasuryAccount } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import { registerSupplierPaymentFromPosShift } from "../purchases/purchases-service";
import type { useSuppliers } from "../purchases/useSuppliers";
import type { useEmployees } from "../employees/useEmployees";
import type { useTreasury } from "../shifts/useTreasury";
import { registerEmployeeValeFromPosShift, type PosShiftVale } from "../employees/employees-service";
import { registerPosShiftTransfer, type PosShift, type PosShiftAdjustment, type PosShiftSale } from "./pos-shift-service";
import { formatShiftStart, type MovementReceiptState } from "./sale-model";

// Panel "Turno" de Mostrador (columna derecha): total del turno, botones,
// listas de movimientos y los formularios de caja / pago a proveedor / vale /
// cierre. Cada formulario tiene su propio estado; el padre (Sale.tsx) solo
// decide cuál está abierto y recibe los avisos (mensaje, comprobante).

type Suppliers = ReturnType<typeof useSuppliers>["suppliers"];
type Employees = ReturnType<typeof useEmployees>["employees"];
type Adjust = ReturnType<typeof useTreasury>["adjust"];

function errorDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "object" && err !== null ? JSON.stringify(err) : String(err);
  const code = (err as { code?: string })?.code;
  return `[detalle: ${raw}${code ? ` · code ${code}` : ""}]`;
}

/* ------------------------------ PIN ------------------------------ */

function PinPrompt({ pin, onSuccess, onCancel }: { pin: string | null; onSuccess: () => void; onCancel: () => void }) {
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState("");

  function confirmPin() {
    if (pinInput.trim() !== pin) {
      setPinError("PIN incorrecto.");
      return;
    }
    onSuccess();
  }

  return (
    <div className="panel" style={{ padding: 14 }}>
      <p style={{ margin: "0 0 8px", fontWeight: 700 }}>Ingresá el PIN para ver esto</p>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="password"
          inputMode="numeric"
          maxLength={4}
          placeholder="PIN"
          autoFocus
          value={pinInput}
          onChange={(e) => setPinInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") confirmPin(); }}
          style={{ width: 80 }}
        />
        <button onClick={confirmPin}>Confirmar</button>
        <button className="secondary" onClick={onCancel}>Cancelar</button>
      </div>
      {pinError && <p style={{ color: "#a52424", margin: "6px 0 0" }}>{pinError}</p>}
    </div>
  );
}

/* ------------------------------ formularios ------------------------------ */

interface FormCommon {
  visible: boolean;
  shift: PosShift | null;
  accounts: TreasuryAccount[];
  onMessage: (message: string) => void;
  /** Muestra (e imprime, si corresponde) el comprobante del movimiento. */
  publishReceipt: (data: MovementReceiptState) => Promise<void>;
  onClose: () => void;
}

function CajaMovementForm({ visible, shift, accounts, adjust, onMessage, publishReceipt, onMovementsChanged, onClose }: FormCommon & {
  adjust: Adjust;
  onMovementsChanged: () => Promise<void>;
}) {
  const [direction, setDirection] = useState<"in" | "out">("out");
  const [accountId, setAccountId] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [reason, setReason] = useState("");
  const [destAccountId, setDestAccountId] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleCajaMovement() {
    onMessage("");
    if (!accountId) { onMessage("Elegí una cuenta."); return; }
    const amount = parseAmount(amountInput || "0") || 0;
    if (!(amount > 0)) { onMessage("El monto debe ser mayor que cero."); return; }
    if (!reason.trim()) { onMessage("Ingresá un motivo."); return; }
    const isTransfer = direction === "out" && !!destAccountId;
    if (isTransfer && !shift) { onMessage("No hay un turno abierto."); return; }
    setBusy(true);
    try {
      const accountName = accounts.find((a) => a.id === accountId)?.name ?? "-";
      let receiptTitle: string;
      if (isTransfer && shift) {
        const destName = accounts.find((a) => a.id === destAccountId)?.name ?? "-";
        await registerPosShiftTransfer({
          posShiftId: shift.id,
          fromAccountId: accountId,
          toAccountId: destAccountId,
          amount,
          reason: reason.trim()
        });
        receiptTitle = `TRASPASO A ${destName.toUpperCase()}`;
      } else {
        const posShiftId = shift && isSupabaseConfigured ? shift.id : undefined;
        await adjust({ accountId, amount, direction, reason: reason.trim(), posShiftId });
        receiptTitle = direction === "in" ? "INGRESO DE CAJA" : "EGRESO DE CAJA";
      }
      await publishReceipt({ title: receiptTitle, date: new Date().toISOString(), amount, accountName, detail: reason.trim() });
      await onMovementsChanged();
      setAccountId("");
      setAmountInput("");
      setReason("");
      setDestAccountId("");
      onClose();
    } catch (err) {
      onMessage(`No se pudo registrar el movimiento de caja. ${errorDetail(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;
  return (
    <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
      <select value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")}>
        <option value="out">Egreso</option>
        <option value="in">Ingreso</option>
      </select>
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
        <option value="">Cuenta…</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      {direction === "out" && (
        <select value={destAccountId} onChange={(e) => setDestAccountId(e.target.value)}>
          <option value="">¿Va a otra cuenta? (opcional, ej. Caja fuerte)</option>
          {accounts.filter((a) => a.id !== accountId).map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      )}
      <input
        type="text"
        inputMode="decimal"
        placeholder="Monto"
        value={amountInput}
        onChange={(e) => setAmountInput(e.target.value)}
      />
      <input
        placeholder="Motivo"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {destAccountId && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Va a quedar como traspaso: sale de acá (cuenta este turno) y entra a la otra cuenta -- el cierre de caja va a restar esta salida del efectivo esperado.
        </p>
      )}
      <button disabled={busy} onClick={handleCajaMovement}>{busy ? "Guardando…" : "Registrar"}</button>
    </div>
  );
}

function SupplierPaymentForm({ visible, shift, accounts, suppliers, onMessage, publishReceipt, onClose }: FormCommon & { suppliers: Suppliers }) {
  const [supplierId, setSupplierId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSupplierPayment() {
    onMessage("");
    if (!shift) { onMessage("No hay un turno abierto."); return; }
    if (!supplierId) { onMessage("Elegí un proveedor."); return; }
    if (!accountId) { onMessage("Elegí una cuenta."); return; }
    const amount = parseAmount(amountInput || "0") || 0;
    if (!(amount > 0)) { onMessage("El monto debe ser mayor que cero."); return; }
    setBusy(true);
    try {
      const result = await registerSupplierPaymentFromPosShift({
        supplierId,
        posShiftId: shift.id,
        accountId,
        amount,
        notes: notes.trim() || undefined
      });
      const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? "-";
      const accountName = accounts.find((a) => a.id === accountId)?.name ?? "-";
      onMessage(`Pago a ${supplierName} registrado.${result.balance !== null ? ` Saldo restante: ${formatMoney(result.balance)}.` : ""}`);
      await publishReceipt({
        title: "PAGO A PROVEEDOR",
        date: new Date().toISOString(),
        amount,
        accountName,
        detail: notes.trim() || "Pago a proveedor",
        counterpartLabel: "Proveedor",
        counterpartName: supplierName
      });
      setSupplierId("");
      setAccountId("");
      setAmountInput("");
      setNotes("");
      onClose();
    } catch (err) {
      onMessage(`No se pudo registrar el pago al proveedor. ${errorDetail(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;
  return (
    <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
      <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
        <option value="">Proveedor…</option>
        {suppliers.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
        <option value="">Pagar desde…</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      <input
        type="text"
        inputMode="decimal"
        placeholder="Monto"
        value={amountInput}
        onChange={(e) => setAmountInput(e.target.value)}
      />
      <input
        placeholder="Nota (opcional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button disabled={busy} onClick={handleSupplierPayment}>{busy ? "Guardando…" : "Registrar"}</button>
    </div>
  );
}

function EmployeeValeForm({ visible, shift, accounts, employees, onMessage, publishReceipt, onMovementsChanged, onClose }: FormCommon & {
  employees: Employees;
  onMovementsChanged: () => Promise<void>;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleEmployeeVale() {
    onMessage("");
    if (!shift) { onMessage("No hay un turno abierto."); return; }
    if (!employeeId) { onMessage("Elegí un empleado."); return; }
    if (!accountId) { onMessage("Elegí una cuenta."); return; }
    const amount = parseAmount(amountInput || "0") || 0;
    if (!(amount > 0)) { onMessage("El monto debe ser mayor que cero."); return; }
    setBusy(true);
    try {
      await registerEmployeeValeFromPosShift({
        employeeId,
        posShiftId: shift.id,
        accountId,
        amount,
        detail: detail.trim() || undefined
      });
      const employeeName = employees.find((e) => e.id === employeeId)?.fullName ?? "-";
      const accountName = accounts.find((a) => a.id === accountId)?.name ?? "-";
      onMessage(`Vale de ${employeeName} registrado -- se descuenta de su próxima liquidación de sueldo.`);
      await publishReceipt({
        title: "VALE A EMPLEADO",
        date: new Date().toISOString(),
        amount,
        accountName,
        detail: detail.trim() || "Vale de adelanto",
        counterpartLabel: "Empleado",
        counterpartName: employeeName
      });
      await onMovementsChanged();
      setEmployeeId("");
      setAccountId("");
      setAmountInput("");
      setDetail("");
      onClose();
    } catch (err) {
      onMessage(`No se pudo registrar el vale. ${errorDetail(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;
  return (
    <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
      <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
        <option value="">Empleado…</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>{e.fullName}</option>
        ))}
      </select>
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
        <option value="">Sale de…</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      <input
        type="text"
        inputMode="decimal"
        placeholder="Monto"
        value={amountInput}
        onChange={(e) => setAmountInput(e.target.value)}
      />
      <input
        placeholder="Detalle (opcional)"
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
      />
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>Se descuenta de la próxima liquidación de sueldo del empleado.</p>
      <button disabled={busy} onClick={handleEmployeeVale}>{busy ? "Guardando…" : "Registrar"}</button>
    </div>
  );
}

/* ------------------------------ panel ------------------------------ */

export interface ShiftPanelProps {
  shift: PosShift;
  canSeeShiftTotals: boolean;
  canManageTreasury: boolean;
  busy: boolean;
  accounts: TreasuryAccount[];
  suppliers: Suppliers;
  employees: Employees;
  adjust: Adjust;

  activeSalesCount: number;
  shiftTotal: number;
  shiftSales: PosShiftSale[];
  showShiftTotals: boolean;
  onToggleShiftTotals: () => void;
  showShiftMovements: boolean;
  showMovementsList: boolean;
  onRequestReveal: (kind: "movements" | "caja") => void;

  pinPromptFor: null | "movements" | "caja";
  mostradorPin: string | null;
  onPinSuccess: () => void;
  onPinCancel: () => void;

  cajaAdjustments: PosShiftAdjustment[];
  posShiftVales: PosShiftVale[];
  deletingMovementId: string | null;
  onDeleteAdjustment: (id: string) => void;
  onDeleteVale: (id: string) => void;
  onVoidSale: (saleId: string) => void;
  onMovementsChanged: () => Promise<void>;

  showCajaForm: boolean;
  onToggleCajaForm: () => void;
  showSupplierForm: boolean;
  onToggleSupplierForm: () => void;
  showValeForm: boolean;
  onToggleValeForm: () => void;

  showCloseConfirm: boolean;
  onRequestClose: () => void;
  closingCountedCashInput: string;
  onCountedCashChange: (value: string) => void;
  onConfirmClose: () => void;
  onCancelClose: () => void;

  onMessage: (message: string) => void;
  publishReceipt: (data: MovementReceiptState) => Promise<void>;
}

export function ShiftPanel(p: ShiftPanelProps) {
  const { shift, canSeeShiftTotals, canManageTreasury } = p;
  const form = { shift, accounts: p.accounts, onMessage: p.onMessage, publishReceipt: p.publishReceipt };

  return (
    <aside className="panel shift-card" style={{ position: "sticky", top: 18 }}>
      <div className="panel-title">
        <h2>Turno</h2>
        <span className="muted" style={{ fontSize: 12 }}>desde {formatShiftStart(shift.openedAt)}</span>
      </div>

      {canSeeShiftTotals && p.showShiftTotals && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          <div style={{ background: "#f8f9fb", borderRadius: 12, padding: "12px 14px" }}>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>Ventas</p>
            <strong style={{ fontSize: 22 }}>{p.activeSalesCount}</strong>
          </div>
          <div style={{ background: "#f8f9fb", borderRadius: 12, padding: "12px 14px" }}>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>Acumulado</p>
            <strong style={{ fontSize: 22 }}>{formatMoney(p.shiftTotal)}</strong>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        {canSeeShiftTotals && (
          <button className="pos-toolbar-btn" onClick={p.onToggleShiftTotals}>
            {p.showShiftTotals ? "Ocultar total del turno" : "Ver total del turno"}
          </button>
        )}
        {canSeeShiftTotals && (
          <button className="pos-toolbar-btn" onClick={() => p.onRequestReveal("movements")}>
            {p.showShiftMovements ? "Ocultar movimientos" : "Ver movimientos"}
          </button>
        )}
        {canManageTreasury && (
          <button className="pos-toolbar-btn" onClick={() => p.onRequestReveal("caja")}>
            {p.showMovementsList ? "Ocultar caja/vales" : "Ver movimientos de caja"}
          </button>
        )}
        {p.pinPromptFor && <PinPrompt pin={p.mostradorPin} onSuccess={p.onPinSuccess} onCancel={p.onPinCancel} />}
        {canManageTreasury && (
          <button className="pos-toolbar-btn" onClick={p.onToggleCajaForm}>
            {p.showCajaForm ? "Cancelar movimiento de caja" : "+ Movimiento de caja"}
          </button>
        )}
        {canManageTreasury && (
          <button className="pos-toolbar-btn" onClick={p.onToggleSupplierForm}>
            {p.showSupplierForm ? "Cancelar pago a proveedor" : "+ Pago a proveedor"}
          </button>
        )}
        {canManageTreasury && (
          <button className="pos-toolbar-btn" onClick={p.onToggleValeForm}>
            {p.showValeForm ? "Cancelar vale a empleado" : "+ Vale a empleado"}
          </button>
        )}
        {!p.showCloseConfirm && (
          <button className="pos-toolbar-btn" onClick={p.onRequestClose}>
            Cerrar turno
          </button>
        )}
      </div>

      {canSeeShiftTotals && p.showShiftMovements && (
        p.shiftSales.length > 0 ? (
          <table className="data-table" style={{ marginTop: 14 }}>
            <thead>
              <tr><th>Hora</th><th className="num">Total</th><th></th><th></th></tr>
            </thead>
            <tbody>
              {p.shiftSales.map((s) => (
                <tr key={s.id} style={s.voidedAt ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                  <td>{new Date(s.createdAt).toLocaleTimeString("es-AR")}</td>
                  <td className="num">{formatMoney(s.total)}</td>
                  <td>{s.voidedAt ? "Anulada" : ""}</td>
                  <td>
                    {!s.voidedAt && (
                      <button className="secondary" disabled={p.busy} onClick={() => p.onVoidSale(s.id)}>Anular</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted" style={{ marginTop: 14 }}>Todavía no hay ventas en este turno.</p>
        )
      )}

      {canManageTreasury && p.showMovementsList && (
        <div style={{ marginTop: 14 }}>
          <p className="muted" style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 12, textTransform: "uppercase" }}>Caja</p>
          {p.cajaAdjustments.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr><th>Hora</th><th>Cuenta</th><th>Motivo</th><th className="num">Monto</th><th></th></tr>
              </thead>
              <tbody>
                {p.cajaAdjustments.map((m) => (
                  <tr key={m.id}>
                    <td>{new Date(m.createdAt).toLocaleTimeString("es-AR")}</td>
                    <td>{m.accountName}</td>
                    <td>{m.notes ?? "-"}</td>
                    <td className="num">{m.direction === "in" ? "+" : "-"}{formatMoney(m.amount)}</td>
                    <td>
                      <button
                        className="secondary"
                        disabled={p.deletingMovementId === m.id}
                        onClick={() => p.onDeleteAdjustment(m.id)}
                      >
                        {p.deletingMovementId === m.id ? "…" : "Borrar"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>Sin movimientos de caja en este turno.</p>
          )}

          <p className="muted" style={{ margin: "14px 0 6px", fontWeight: 700, fontSize: 12, textTransform: "uppercase" }}>Vales a empleados</p>
          {p.posShiftVales.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr><th>Hora</th><th>Empleado</th><th>Detalle</th><th className="num">Monto</th><th></th></tr>
              </thead>
              <tbody>
                {p.posShiftVales.map((v) => (
                  <tr key={v.id}>
                    <td>{new Date(v.createdAt).toLocaleTimeString("es-AR")}</td>
                    <td>{v.employeeName}</td>
                    <td>{v.detail}{v.liquidated && <span className="muted"> · Liquidado</span>}</td>
                    <td className="num">{formatMoney(v.amount)}</td>
                    <td>
                      {!v.liquidated && (
                        <button
                          className="secondary"
                          disabled={p.deletingMovementId === v.id}
                          onClick={() => p.onDeleteVale(v.id)}
                        >
                          {p.deletingMovementId === v.id ? "…" : "Borrar"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>Sin vales cargados en este turno.</p>
          )}
        </div>
      )}

      {canManageTreasury && (
        <>
          <CajaMovementForm {...form} visible={p.showCajaForm} adjust={p.adjust} onMovementsChanged={p.onMovementsChanged} onClose={p.onToggleCajaForm} />
          <SupplierPaymentForm {...form} visible={p.showSupplierForm} suppliers={p.suppliers} onClose={p.onToggleSupplierForm} />
          <EmployeeValeForm {...form} visible={p.showValeForm} employees={p.employees} onMovementsChanged={p.onMovementsChanged} onClose={p.onToggleValeForm} />
        </>
      )}

      {p.showCloseConfirm && (
        <div style={{ marginTop: 14 }}>
          <p className="muted">¿Cerrar el turno y cargar {formatMoney(p.shiftTotal)} a Tesorería? No se puede deshacer.</p>
          <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
            <label className="muted" style={{ fontSize: 13 }}>Efectivo contado (arqueo) $</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={p.closingCountedCashInput}
              onChange={(e) => p.onCountedCashChange(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={p.busy} onClick={p.onConfirmClose}>{p.busy ? "Cerrando…" : "Confirmar cierre"}</button>
            <button className="secondary" onClick={p.onCancelClose}>Cancelar</button>
          </div>
        </div>
      )}
    </aside>
  );
}
