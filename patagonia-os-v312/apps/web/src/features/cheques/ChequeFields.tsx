import { parseAmount } from "../../lib/money";
import { validateChequeInput } from "./cheque-logic";

// Datos de un cheque, compartidos por Cheques, Clientes (cobrar con cheque) y
// Compras (pagar con cheque propio).

export interface ChequeForm {
  number: string;
  bank: string;
  amount: string;
  payDate: string;
  echeq: boolean;
  drawerName: string;
  drawerCuit: string;
}

export const EMPTY_CHEQUE: ChequeForm = { number: "", bank: "", amount: "", payDate: "", echeq: false, drawerName: "", drawerCuit: "" };

/** Valida y convierte. `amountText` reemplaza al monto del formulario cuando
 * la pantalla ya tiene su propio campo de monto. */
export function readChequeForm(form: ChequeForm, amountText?: string): { error: string } | { amount: number } {
  const amount = parseAmount(amountText ?? form.amount);
  const error = validateChequeInput({ number: form.number, amount, payDate: form.payDate, cuit: form.drawerCuit });
  return error ? { error } : { amount };
}

export function ChequeFields({ value, onChange, withAmount = true, withDrawer = true, bankLabel = "Banco" }: {
  value: ChequeForm;
  onChange: (next: ChequeForm) => void;
  withAmount?: boolean;
  /** Quién firma el cheque (solo en los recibidos). */
  withDrawer?: boolean;
  bankLabel?: string;
}) {
  const set = (patch: Partial<ChequeForm>) => onChange({ ...value, ...patch });
  return (
    <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={value.echeq} onChange={(e) => set({ echeq: e.target.checked })} style={{ width: "auto", minWidth: 0 }} />
        eCheq
      </label>
      <input placeholder="N.º de cheque" value={value.number} onChange={(e) => set({ number: e.target.value })} style={{ width: 140 }} />
      {withDrawer && <input placeholder={bankLabel} value={value.bank} onChange={(e) => set({ bank: e.target.value })} style={{ width: 140 }} />}
      {withAmount && <input type="text" inputMode="decimal" placeholder="Monto" value={value.amount} onChange={(e) => set({ amount: e.target.value })} style={{ width: 130 }} />}
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        Se cobra el
        <input type="date" value={value.payDate} onChange={(e) => set({ payDate: e.target.value })} />
      </label>
      {withDrawer && (
        <>
          <input placeholder="Quién lo firma (opcional)" value={value.drawerName} onChange={(e) => set({ drawerName: e.target.value })} style={{ width: 190 }} />
          <input placeholder="CUIT (opcional)" inputMode="numeric" value={value.drawerCuit} onChange={(e) => set({ drawerCuit: e.target.value })} style={{ width: 150 }} />
        </>
      )}
    </div>
  );
}
