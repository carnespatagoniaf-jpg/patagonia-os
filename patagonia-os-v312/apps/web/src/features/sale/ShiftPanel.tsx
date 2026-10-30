import { Fragment, useEffect, useState } from "react";
import type { TreasuryAccount } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { parseAmount } from "../../lib/money";
import { formatMoney } from "../shifts/format";
import { registerSupplierPaymentFromPosShift } from "../purchases/purchases-service";
import type { useSuppliers } from "../purchases/useSuppliers";
import type { useEmployees } from "../employees/useEmployees";
import type { useTreasury } from "../shifts/useTreasury";
import { registerEmployeeValeFromPosShift, type PosShiftVale } from "../employees/employees-service";
import { listPosShiftWithdrawals, registerPosSafeDeposit, registerPosShiftExpense, registerPosShiftTransfer, voidPosCashWithdrawal, type PosShiftWithdrawal, type PosCashier, type PosShift, type PosShiftAdjustment, type PosShiftSale, type SafeDepositResult } from "./pos-shift-service";
import { BlindCloseForm } from "./BlindCloseForm";
import { formatShiftStart, type MovementReceiptState } from "./sale-model";
import type { Product } from "@patagonia/domain";
import type { ScaleConfig } from "./scale-barcode";
import { ScaleCloseControl, ScaleVoidForm } from "./ScaleControl";
import { WasteForm } from "./WasteForm";
import { VOID_REASONS, isValidAuthPin, voidReasonText } from "./void-sale";

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

/* ------------------------- Anular venta (149) ------------------------- */

function VoidSaleForm({ total, pinRequired, busy, onSubmit, onDone }: {
  total: number;
  pinRequired: boolean;
  busy: boolean;
  onSubmit: (reason: string, pin: string | null) => Promise<string | null>;
  onDone: () => void;
}) {
  const [choice, setChoice] = useState("");
  const [other, setOther] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    const parsed = voidReasonText(choice, other);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    if (pinRequired && !isValidAuthPin(pin)) {
      setError("Falta el PIN de autorización del encargado.");
      return;
    }
    setError("");
    const err = await onSubmit(parsed.reason, pinRequired ? pin.trim() : null);
    if (err) {
      setError(err);
      setPin("");
    } else {
      onDone();
    }
  }

  return (
    <div style={{ display: "grid", gap: 8, padding: "8px 0" }}>
      <p style={{ margin: 0, fontWeight: 700 }}>Anular venta de {formatMoney(total)}</p>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>El stock vuelve y la venta deja de contar en la caja. El dueño la ve en Control de caja.</p>
      <select value={choice} onChange={(e) => setChoice(e.target.value)} autoFocus>
        <option value="">¿Por qué se anula?</option>
        {VOID_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      {choice === "Otro" && <input placeholder="Escribí el motivo" value={other} maxLength={180} onChange={(e) => setOther(e.target.value)} />}
      {pinRequired && (
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          placeholder="PIN de autorización"
          value={pin}
          maxLength={6}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        />
      )}
      {error && <p style={{ color: "#a52424", margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={busy} onClick={() => void submit()}>{busy ? "Anulando…" : "Anular venta"}</button>
        <button className="secondary" onClick={onDone}>Cancelar</button>
      </div>
    </div>
  );
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

/**
 * Borrar un movimiento de caja o un vale: nunca con un solo toque. Pregunta, y
 * si el dueño cargó el PIN de autorización lo pide (migración 153; el servidor
 * lo vuelve a controlar).
 */
function ConfirmDelete({ label, pinRequired, busy, onConfirm }: {
  label: string;
  pinRequired: boolean;
  busy: boolean;
  onConfirm: (pin: string | null) => Promise<string | null>;
}) {
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  if (!asking) {
    return <button className="secondary" disabled={busy} onClick={() => { setAsking(true); setError(""); }}>{label}</button>;
  }

  async function confirm() {
    if (pinRequired && !pin.trim()) { setError("Poné el PIN de autorización."); return; }
    const result = await onConfirm(pinRequired ? pin.trim() : null);
    if (result) { setError(result); setPin(""); } else { setAsking(false); setPin(""); }
  }

  return (
    <div style={{ display: "grid", gap: 4, minWidth: 150 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: "#8b1e1e" }}>¿Seguro? No se puede deshacer.</span>
      {pinRequired && (
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void confirm(); } }}
          placeholder="PIN de autorización"
          autoFocus
          style={{ padding: "5px 8px", fontSize: 13 }}
        />
      )}
      <div style={{ display: "flex", gap: 4 }}>
        <button className="danger" disabled={busy} onClick={() => void confirm()} style={{ padding: "4px 10px", fontSize: 12 }}>{busy ? "…" : "Sí, borrar"}</button>
        <button className="secondary" disabled={busy} onClick={() => { setAsking(false); setPin(""); setError(""); }} style={{ padding: "4px 10px", fontSize: 12 }}>No</button>
      </div>
      {error && <span style={{ fontSize: 12, color: "#a52424" }}>{error}</span>}
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

/** Las cuentas de efectivo (sale del cajón). Mostrador ya no recibe las de caja fuerte. */
function cashAccountsOf(accounts: TreasuryAccount[]) {
  return accounts.filter((a) => a.paymentMethod === "cash");
}

function SupplierPaymentForm({ visible, shift, accounts, suppliers, onCreateSupplier, onMessage, publishReceipt, onClose }: FormCommon & {
  suppliers: Suppliers;
  /** "+ Proveedor nuevo" (el químico o la papelera casi nunca están cargados): devuelve el id. */
  onCreateSupplier: (name: string) => Promise<string>;
}) {
  const cash = cashAccountsOf(accounts);
  const [supplierId, setSupplierId] = useState("");
  const [pickedAccountId, setAccountId] = useState("");
  const accountId = pickedAccountId || (cash.length === 1 ? cash[0].id : "");
  const [amountInput, setAmountInput] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);

  async function handleCreateSupplier() {
    const name = (newName ?? "").trim();
    if (!name) { onMessage("Escribí el nombre del proveedor."); return; }
    setBusy(true);
    try {
      setSupplierId(await onCreateSupplier(name));
      setNewName(null);
    } catch (err) {
      onMessage(`No se pudo agregar el proveedor. ${errorDetail(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSupplierPayment() {
    onMessage("");
    if (!shift) { onMessage("No hay un turno abierto."); return; }
    if (!supplierId) { onMessage("Elegí un proveedor."); return; }
    if (!accountId) { onMessage("Elegí de qué caja sale la plata."); return; }
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
    <div style={{ display: "grid", gap: 8 }}>
      {newName === null ? (
        <div style={{ display: "flex", gap: 8 }}>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
            <option value="">¿A qué proveedor?</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button type="button" className="secondary" onClick={() => setNewName("")}>+ Nuevo</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <input autoFocus placeholder="Nombre (ej. Química del Sur)" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          <button type="button" disabled={busy} onClick={() => void handleCreateSupplier()}>Agregar</button>
          <button type="button" className="secondary" onClick={() => setNewName(null)}>×</button>
        </div>
      )}
      {cash.length > 1 && (
        <select value={pickedAccountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">¿De qué caja sale?</option>
          {cash.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      )}
      <input
        type="text"
        inputMode="decimal"
        placeholder="Monto $"
        value={amountInput}
        onChange={(e) => setAmountInput(e.target.value)}
        style={{ fontSize: 18 }}
      />
      <input
        placeholder="Nota (opcional, ej. factura 1234)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button disabled={busy} onClick={handleSupplierPayment}>{busy ? "Guardando…" : "Pagar"}</button>
    </div>
  );
}

function EmployeeValeForm({ visible, shift, accounts, employees, onMessage, publishReceipt, onMovementsChanged, onClose }: FormCommon & {
  employees: Employees;
  onMovementsChanged: () => Promise<void>;
}) {
  const cash = cashAccountsOf(accounts);
  const [employeeId, setEmployeeId] = useState("");
  const [pickedAccountId, setAccountId] = useState("");
  const accountId = pickedAccountId || (cash.length === 1 ? cash[0].id : "");
  const [amountInput, setAmountInput] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleEmployeeVale() {
    onMessage("");
    if (!shift) { onMessage("No hay un turno abierto."); return; }
    if (!employeeId) { onMessage("Elegí un empleado."); return; }
    if (!accountId) { onMessage("Elegí de qué caja sale la plata."); return; }
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
    <div style={{ display: "grid", gap: 8 }}>
      <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
        <option value="">¿A qué empleado?</option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>{e.fullName}</option>
        ))}
      </select>
      {cash.length > 1 && (
        <select value={pickedAccountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">¿De qué caja sale?</option>
          {cash.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      )}
      <input
        type="text"
        inputMode="decimal"
        placeholder="Monto $"
        value={amountInput}
        onChange={(e) => setAmountInput(e.target.value)}
        style={{ fontSize: 18 }}
      />
      <input
        placeholder="Detalle (opcional)"
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
      />
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>Se descuenta de la próxima liquidación de sueldo del empleado.</p>
      <button disabled={busy} onClick={handleEmployeeVale}>{busy ? "Guardando…" : "Dar el vale"}</button>
    </div>
  );
}

/** "Retiro de dinero" (migración 164): solo el monto. Imprime el papelito con número que va con la plata; el dueño
 * después cuenta los papelitos. La plata sigue siendo Efectivo de Tesorería. */
function SafeDepositForm({ visible, shift, accounts, onMessage, onDone, onMovementsChanged, onClose }: {
  visible: boolean;
  shift: PosShift;
  accounts: TreasuryAccount[];
  onMessage: (message: string) => void;
  onDone: (deposit: SafeDepositResult) => Promise<void>;
  onMovementsChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const cashAccounts = cashAccountsOf(accounts);
  const [amountInput, setAmountInput] = useState("");
  const [fromAccountId, setFromAccountId] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    onMessage("");
    const amount = parseAmount(amountInput || "0") || 0;
    if (!(amount > 0)) { onMessage("Poné cuánta plata retirás."); return; }
    if (cashAccounts.length > 1 && !fromAccountId) { onMessage("Elegí de qué caja sale la plata."); return; }
    setBusy(true);
    try {
      const deposit = await registerPosSafeDeposit(shift.id, amount, cashAccounts.length > 1 ? fromAccountId : cashAccounts[0]?.id ?? null);
      await onMovementsChanged();
      await onDone(deposit);
      setAmountInput("");
      onClose();
    } catch (err) {
      onMessage(`No se pudo anotar el retiro. ${errorDetail(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {cashAccounts.length > 1 && (
        <select value={fromAccountId} onChange={(e) => setFromAccountId(e.target.value)}>
          <option value="">¿De qué caja sale?</option>
          {cashAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      )}
      <input
        type="text"
        inputMode="decimal"
        placeholder="¿Cuánto retirás? $"
        autoFocus
        value={amountInput}
        onChange={(e) => setAmountInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void handleSave(); }}
        style={{ fontSize: 18 }}
      />
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>Sale un papelito con número: va junto con la plata. El dueño después cuenta los papelitos.</p>
      <button disabled={busy} onClick={handleSave}>{busy ? "Guardando…" : "Retirar"}</button>
    </div>
  );
}

/** Gastos rápidos: un toque y queda la descripción y la categoría. */
const EXPENSE_PRESETS: Array<{ label: string; category: string }> = [
  { label: "Hielo", category: "insumos" },
  { label: "Bolsas", category: "insumos" },
  { label: "Limpieza", category: "insumos" },
  { label: "Librería", category: "insumos" },
  { label: "Flete", category: "servicios" },
  { label: "Otro", category: "otro" }
];

/** "Gasto del local" (migración 164): sale del Efectivo del turno. */
function ExpenseForm({ shift, onMessage, publishReceipt, onMovementsChanged, onClose }: {
  shift: PosShift;
  onMessage: (message: string) => void;
  publishReceipt: (data: MovementReceiptState) => Promise<void>;
  onMovementsChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [preset, setPreset] = useState<string>("");
  const [detail, setDetail] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = EXPENSE_PRESETS.find((p) => p.label === preset);

  async function handleSave() {
    onMessage("");
    if (!chosen) { onMessage("Tocá en qué se gastó."); return; }
    const description = detail.trim() || (chosen.label === "Otro" ? "" : chosen.label);
    if (!description) { onMessage("Escribí en qué se gastó."); return; }
    const amount = parseAmount(amountInput || "0") || 0;
    if (!(amount > 0)) { onMessage("El monto debe ser mayor que cero."); return; }
    setBusy(true);
    try {
      const result = await registerPosShiftExpense(shift.id, amount, chosen.category, description);
      await publishReceipt({ title: "GASTO DEL LOCAL", date: new Date().toISOString(), amount, accountName: result.accountName, detail: description });
      await onMovementsChanged();
      onMessage(`Gasto anotado: ${description} ${formatMoney(amount)}.`);
      onClose();
    } catch (err) {
      onMessage(`No se pudo anotar el gasto. ${errorDetail(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="type-chips compact" style={{ margin: 0 }}>
        {EXPENSE_PRESETS.map((p) => (
          <button key={p.label} type="button" className={`type-chip${preset === p.label ? " active" : ""}`} onClick={() => setPreset(p.label)}>{p.label}</button>
        ))}
      </div>
      <input placeholder={chosen?.label === "Otro" ? "¿En qué se gastó?" : "Detalle (opcional)"} value={detail} onChange={(e) => setDetail(e.target.value)} />
      <input type="text" inputMode="decimal" placeholder="Monto $" value={amountInput} onChange={(e) => setAmountInput(e.target.value)} style={{ fontSize: 18 }} />
      <button disabled={busy} onClick={handleSave}>{busy ? "Guardando…" : "Anotar el gasto"}</button>
    </div>
  );
}

type CashOutKind = "proveedor" | "vale" | "gasto" | "retiro";

const CASH_OUT_OPTIONS: Array<{ kind: CashOutKind; title: string; hint: string }> = [
  { kind: "proveedor", title: "Pagarle a un proveedor", hint: "Químico, papelera, pollero" },
  { kind: "vale", title: "Vale a un empleado", hint: "Se descuenta del sueldo" },
  { kind: "gasto", title: "Gasto del local", hint: "Hielo, bolsas, flete" },
  { kind: "retiro", title: "Retiro de dinero", hint: "Imprime el papelito numerado" }
];

/* ------------------------------ panel ------------------------------ */

export interface ShiftPanelProps {
  /** Sucursal del turno: la lista de retiros trae también los sin contar de turnos anteriores. */
  branchId: string | null;
  shift: PosShift;
  canSeeShiftTotals: boolean;
  canManageTreasury: boolean;
  /** Empleados (vales) es del plan Estándar en adelante. */
  canUseEmployees: boolean;
  /** Para "Anular ticket de balanza" (leer el código del ticket). */
  products: Product[];
  scaleConfig: ScaleConfig;
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
  /** Devuelven el error para mostrar, o null si se borró. Piden confirmar y, si hay, el PIN de autorización. */
  onDeleteAdjustment: (id: string, authPin: string | null) => Promise<string | null>;
  onDeleteVale: (id: string, authPin: string | null) => Promise<string | null>;
  /** Devuelve el error para mostrar en el formulario, o null si anuló. */
  onVoidSale: (saleId: string, reason: string, authPin: string | null) => Promise<string | null>;
  /** La empresa cargó PIN de autorización para anular (migración 149). */
  voidPinRequired: boolean;
  onMovementsChanged: () => Promise<void>;

  showCajaForm: boolean;
  onToggleCajaForm: () => void;
  showSupplierForm: boolean;
  onToggleSupplierForm: () => void;
  showValeForm: boolean;
  onToggleValeForm: () => void;

  showCloseConfirm: boolean;
  onRequestClose: () => void;
  /** Cajeras con PIN (vacío = no se pide quién cierra). */
  cashiers: PosCashier[];
  onConfirmClose: (countedCash: number, declaredAccounts: Record<string, string>) => void;
  onCancelClose: () => void;
  onSalesChanged: () => Promise<void>;
  /** Papelito del retiro de dinero: se muestra e imprime siempre. */
  onSafeDeposit: (deposit: SafeDepositResult) => Promise<void>;
  /** "Controlar la balanza al cerrar" (companies.features 'control_balanza', migración 164): si no, ni el control ni "Anular ticket de balanza". */
  scaleCloseControl: boolean;
  /** "+ Nuevo" proveedor desde "Pagarle a un proveedor": devuelve el id. */
  onCreateSupplier: (name: string) => Promise<string>;

  onMessage: (message: string) => void;
  publishReceipt: (data: MovementReceiptState) => Promise<void>;
}

export function ShiftPanel(p: ShiftPanelProps) {
  const { shift, canSeeShiftTotals, canManageTreasury } = p;
  const form = { shift, accounts: p.accounts, onMessage: p.onMessage, publishReceipt: p.publishReceipt };
  const [showScaleVoid, setShowScaleVoid] = useState(false);
  // Decomiso (migraciones 151 y 152): todos los planes.
  const [showWaste, setShowWaste] = useState(false);
  const [voidingSaleId, setVoidingSaleId] = useState<string | null>(null);
  // "Sacar plata del cajón": null = cerrado, "menu" = las 4 opciones, o la elegida.
  const [cashOut, setCashOut] = useState<null | "menu" | CashOutKind>(null);
  const [showMore, setShowMore] = useState(false);
  const [scaleControlStatus, setScaleControlStatus] = useState({ needed: false, saved: false });
  const [withdrawals, setWithdrawals] = useState<PosShiftWithdrawal[]>([]);
  const [withdrawalsKey, setWithdrawalsKey] = useState(0);
  // Con una lista o un formulario abierto, el panel se ensancha (styles.css, .pos-grid:has(...)).
  const expanded = Boolean(
    p.showShiftMovements || p.showMovementsList || cashOut ||
    p.showCloseConfirm || p.pinPromptFor || showScaleVoid || showWaste || voidingSaleId
  );

  // Retiros de este turno, para la lista "Ver movimientos de caja" (anular uno mal cargado).
  useEffect(() => {
    if (!canManageTreasury || !p.showMovementsList || !isSupabaseConfigured || !p.branchId) return;
    listPosShiftWithdrawals(shift.id, p.branchId).then(setWithdrawals).catch(() => setWithdrawals([]));
  }, [canManageTreasury, p.showMovementsList, shift.id, p.branchId, withdrawalsKey]);

  async function movementsChanged() {
    setWithdrawalsKey((k) => k + 1);
    await p.onMovementsChanged();
  }

  function confirmCloseWithScaleCheck(countedCash: number, declaredAccounts: Record<string, string>) {
    if (
      p.scaleCloseControl &&
      scaleControlStatus.needed &&
      !scaleControlStatus.saved &&
      !window.confirm("No cargaste el control de la balanza (el TOTAL DEL DIA que imprime la balanza). ¿Cerrar el turno igual?")
    ) {
      return;
    }
    p.onConfirmClose(countedCash, declaredAccounts);
  }

  return (
    <aside className={`panel shift-card${expanded ? " expanded" : ""}`}>
      <div className="panel-title">
        <h2>Turno</h2>
        <span className="muted" style={{ fontSize: 12 }}>desde {formatShiftStart(shift.openedAt)}</span>
      </div>
      {shift.cashierName && (
        <p style={{ margin: "-6px 0 12px", fontSize: 13 }}>Atiende: <strong>{shift.cashierName}</strong></p>
      )}

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

      <div className="shift-actions">
        <button
          className="pos-toolbar-btn wide"
          style={{ border: "2px solid #2563eb", color: "#1d4ed8", fontWeight: 700 }}
          onClick={() => setCashOut((v) => (v ? null : "menu"))}
        >
          {cashOut ? "Cancelar" : "Sacar plata del cajón"}
        </button>
        {cashOut === "menu" && (
          <div className="cash-out-menu">
            <p style={{ margin: 0, fontWeight: 700 }}>¿Para qué?</p>
            {CASH_OUT_OPTIONS.filter((o) => o.kind !== "vale" || p.canUseEmployees).map((o) => (
              <button key={o.kind} type="button" className="cash-out-option" onClick={() => setCashOut(o.kind)}>
                <strong>{o.title}</strong>
                <small>{o.hint}</small>
              </button>
            ))}
          </div>
        )}
        {cashOut && cashOut !== "menu" && (
          <div className="cash-out-form">
            <p style={{ margin: 0, fontWeight: 700 }}>
              {CASH_OUT_OPTIONS.find((o) => o.kind === cashOut)?.title}{" "}
              <button type="button" className="link-button" onClick={() => setCashOut("menu")}>Cambiar</button>
            </p>
            {cashOut === "proveedor" && (
              <SupplierPaymentForm {...form} visible suppliers={p.suppliers} onCreateSupplier={p.onCreateSupplier} onClose={() => setCashOut(null)} />
            )}
            {cashOut === "vale" && (
              <EmployeeValeForm {...form} visible employees={p.employees} onMovementsChanged={movementsChanged} onClose={() => setCashOut(null)} />
            )}
            {cashOut === "gasto" && (
              <ExpenseForm shift={shift} onMessage={p.onMessage} publishReceipt={p.publishReceipt} onMovementsChanged={movementsChanged} onClose={() => setCashOut(null)} />
            )}
            {cashOut === "retiro" && (
              <SafeDepositForm
                visible
                shift={shift}
                accounts={p.accounts}
                onMessage={p.onMessage}
                onDone={p.onSafeDeposit}
                onMovementsChanged={movementsChanged}
                onClose={() => setCashOut(null)}
              />
            )}
          </div>
        )}
        {!p.showCloseConfirm && (
          <button className="pos-toolbar-btn wide" onClick={p.onRequestClose}>
            Cerrar caja
          </button>
        )}
        <button className="pos-toolbar-btn" onClick={() => setShowMore((v) => !v)}>
          Más {showMore ? "▴" : "▾"}
        </button>
        {showMore && (
          <>
            <button className="pos-toolbar-btn" onClick={() => setShowWaste((v) => !v)}>
              {showWaste ? "Cerrar decomiso" : "Decomiso"}
            </button>
            {p.scaleCloseControl && (
              <button className="pos-toolbar-btn" onClick={() => setShowScaleVoid((v) => !v)}>
                {showScaleVoid ? "Cerrar anular ticket de balanza" : "Anular ticket de balanza"}
              </button>
            )}
            {canSeeShiftTotals && (
              <button className="pos-toolbar-btn" onClick={p.onToggleShiftTotals}>
                {p.showShiftTotals ? "Ocultar total del turno" : "Ver total del turno"}
              </button>
            )}
            {canSeeShiftTotals && (
              <button className="pos-toolbar-btn" onClick={() => p.onRequestReveal("movements")}>
                {p.showShiftMovements ? "Ocultar ventas" : "Ver ventas (anular)"}
              </button>
            )}
            {canManageTreasury && (
              <button className="pos-toolbar-btn" onClick={() => p.onRequestReveal("caja")}>
                {p.showMovementsList ? "Ocultar lo que salió" : "Ver lo que salió del cajón"}
              </button>
            )}
          </>
        )}
        {p.pinPromptFor && <PinPrompt pin={p.mostradorPin} onSuccess={p.onPinSuccess} onCancel={p.onPinCancel} />}
      </div>

      {canSeeShiftTotals && p.showShiftMovements && (
        p.shiftSales.length > 0 ? (
          <table className="data-table" style={{ marginTop: 14 }}>
            <thead>
              <tr><th>Hora</th><th className="num">Total</th><th></th><th></th></tr>
            </thead>
            <tbody>
              {p.shiftSales.map((s) => (
                <Fragment key={s.id}>
                  <tr style={s.voidedAt ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                    <td>{new Date(s.createdAt).toLocaleTimeString("es-AR")}</td>
                    <td className="num">{formatMoney(s.total)}</td>
                    <td>{s.voidedAt ? "Anulada" : ""}</td>
                    <td>
                      {!s.voidedAt && voidingSaleId !== s.id && (
                        <button className="secondary" disabled={p.busy} onClick={() => setVoidingSaleId(s.id)}>Anular</button>
                      )}
                    </td>
                  </tr>
                  {voidingSaleId === s.id && !s.voidedAt && (
                    <tr>
                      <td colSpan={4}>
                        <VoidSaleForm
                          total={s.total}
                          pinRequired={p.voidPinRequired}
                          busy={p.busy}
                          onSubmit={(reason, pin) => p.onVoidSale(s.id, reason, pin)}
                          onDone={() => setVoidingSaleId(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
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
                      <ConfirmDelete
                        label={(m.notes ?? "").startsWith("Caja fuerte") ? "Anular retiro" : "Borrar"}
                        pinRequired={p.voidPinRequired}
                        busy={p.deletingMovementId === m.id}
                        onConfirm={(pin) => p.onDeleteAdjustment(m.id, pin)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>Sin movimientos de caja en este turno.</p>
          )}

          <p className="muted" style={{ margin: "14px 0 6px", fontWeight: 700, fontSize: 12, textTransform: "uppercase" }}>Retiros de dinero (los de este turno y los que el dueño todavía no contó)</p>
          {withdrawals.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr><th>Hora</th><th>Papelito</th><th className="num">Monto</th><th></th></tr>
              </thead>
              <tbody>
                {withdrawals.map((w) => (
                  <tr key={w.id}>
                    <td>
                      {w.previousShift
                        ? new Date(w.createdAt).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
                        : new Date(w.createdAt).toLocaleTimeString("es-AR")}
                    </td>
                    <td>N.º {w.number}</td>
                    <td className="num">{formatMoney(w.amount)}</td>
                    <td>
                      {w.previousShift ? (
                        <span className="muted" style={{ fontSize: 12 }}>Turno anterior · sin contar</span>
                      ) : (
                      <ConfirmDelete
                        label="Anular retiro"
                        pinRequired={p.voidPinRequired}
                        busy={false}
                        onConfirm={async (pin) => {
                          try {
                            const result = await voidPosCashWithdrawal(w.id, pin);
                            if (!result.ok) return result.error ?? "No se pudo anular.";
                            await movementsChanged();
                            p.onMessage(`Retiro N.º ${w.number} anulado.`);
                            return null;
                          } catch (err) {
                            return err instanceof Error ? err.message : "No se pudo anular.";
                          }
                        }}
                      />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>Sin retiros sin contar.</p>
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
                        <ConfirmDelete
                          label="Borrar"
                          pinRequired={p.voidPinRequired}
                          busy={p.deletingMovementId === v.id}
                          onConfirm={(pin) => p.onDeleteVale(v.id, pin)}
                        />
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


      <ScaleVoidForm
        visible={showScaleVoid}
        shift={shift}
        products={p.products}
        scaleConfig={p.scaleConfig}
        onMessage={p.onMessage}
        onClose={() => setShowScaleVoid(false)}
      />

      <WasteForm
        visible={showWaste}
        shift={shift}
        products={p.products}
        scaleConfig={p.scaleConfig}
        canVoid={canManageTreasury}
        onMessage={p.onMessage}
        onClose={() => setShowWaste(false)}
      />

      {p.showCloseConfirm && (
        <div style={{ marginTop: 14 }}>
          {p.scaleCloseControl && <ScaleCloseControl shift={shift} onStatusChange={setScaleControlStatus} />}
          <BlindCloseForm
            oneShot={!canSeeShiftTotals}
            shift={shift}
            accounts={p.accounts}
            cashiers={p.cashiers}
            shiftSales={p.shiftSales}
            busy={p.busy}
            onSalesChanged={p.onSalesChanged}
            onConfirmClose={confirmCloseWithScaleCheck}
            onCancel={p.onCancelClose}
          />
        </div>
      )}
    </aside>
  );
}
