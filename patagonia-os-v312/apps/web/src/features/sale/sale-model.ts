import type { Product } from "@patagonia/domain";
import { POS_LAST_RECEIPT_KEY } from "../../lib/pos-receipt-storage";

// Tipos, constantes y funciones sueltas de Mostrador (sin React), separados de
// Sale.tsx para que la pantalla no sea un solo archivo de miles de líneas.

export const UNIT_LABELS: Record<Product["unit"], string> = { kg: "kg", unit: "unidad", box: "caja" };

export interface TicketLine {
  key: string;
  kind: "product" | "manual";
  productId?: string;
  name: string;
  unit: Product["unit"];
  quantity: number;
  unitPrice: number;
}

export interface PaymentRow {
  accountId: string;
  amount: string;
  /** Cupón o número de operación -- se pide solo si la cuenta elegida no
   * es efectivo (ver checkout()), para que no se pueda marcar "Tarjeta" o
   * "Transferencia" sin tener el comprobante real en la mano. */
  reference: string;
}

export interface ReceiptLine {
  name: string;
  unit: Product["unit"];
  quantity: number;
  unitPrice: number;
  discountAmount: number;
}

export interface ReceiptState {
  items: ReceiptLine[];
  saleDiscount: number;
  saleSurcharge: number;
  total: number;
  soldAt: string;
  paymentSummary: string;
  amountTendered: number | null;
  change: number | null;
  /** true si esta venta se guardó localmente porque no había conexión al
   * cobrar -- todavía no llegó al servidor, se sube sola cuando vuelva
   * internet (ver features/sale/offline-queue.ts). */
  pending?: boolean;
}

/** Comprobante imprimible para movimientos que no son una venta -- caja,
 * pago a proveedor, vale a empleado -- con renglón de firma, para que el
 * proveedor o el empleado firmen que recibieron la plata. */
export interface MovementReceiptState {
  title: string;
  date: string;
  amount: number;
  accountName: string;
  detail: string;
  counterpartLabel?: string;
  counterpartName?: string;
}

const AUTO_PRINT_KEY = "patagonia-auto-print-enabled";

/** Pasadas estas horas se avisa que el turno hay que cerrarlo: la plata de las
 * ventas no llega a Tesorería hasta el cierre, y un turno de días descuadra
 * el arqueo y le pone a todo la fecha del día en que finalmente se cierre. */
export const STALE_SHIFT_HOURS = 18;

export function formatShiftStart(openedAt: string): string {
  const opened = new Date(openedAt);
  if (opened.toDateString() === new Date().toDateString()) return opened.toLocaleTimeString("es-AR");
  return opened.toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Por caja/equipo (localStorage), no por empresa -- cada mostrador puede
 * tener o no una impresora conectada. Por defecto apagado: a quien nunca
 * lo prendió no le tiene que aparecer un diálogo de impresión de la nada. */
export function getAutoPrintEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_PRINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveAutoPrintEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_PRINT_KEY, enabled ? "1" : "0");
  } catch {
    // localStorage lleno o bloqueado -- no es crítico.
  }
}

/** El "Último comprobante" vivía solo en el estado de React -- al salir de
 * Mostrador (a Turnos, Productos, lo que sea) el componente se desmonta y
 * se perdía, aunque la venta ya esté guardada. sessionStorage lo mantiene
 * mientras dure la pestaña/turno, sin guardarlo para siempre. AuthProvider
 * limpia esta misma clave al cerrar sesión, para que no quede pegado el
 * comprobante de una empresa al entrar con otra cuenta en la misma pestaña. */
export function loadStoredReceipt(): ReceiptState | null {
  try {
    const raw = sessionStorage.getItem(POS_LAST_RECEIPT_KEY);
    return raw ? (JSON.parse(raw) as ReceiptState) : null;
  } catch {
    return null;
  }
}

export function saveStoredReceipt(receipt: ReceiptState | null): void {
  try {
    if (receipt) sessionStorage.setItem(POS_LAST_RECEIPT_KEY, JSON.stringify(receipt));
    else sessionStorage.removeItem(POS_LAST_RECEIPT_KEY);
  } catch {
    // sessionStorage lleno o bloqueado -- no es crítico.
  }
}
