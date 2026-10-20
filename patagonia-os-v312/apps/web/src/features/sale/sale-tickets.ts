import type { TreasuryAccount } from "@patagonia/domain";
import type { PosShiftVale } from "../employees/employees-service";
import type { CloseShiftResult, PosShiftAdjustment, PosShiftSupplierPayment } from "./pos-shift-service";
import { formatMoney } from "../shifts/format";
import { getThermalPrintSettings, TicketBuilder } from "./thermal-printer";
import { UNIT_LABELS, type MovementReceiptState, type ReceiptState } from "./sale-model";
import {
  CUSTOMER_CONDITION_LABEL,
  VOUCHER_NAME,
  arDateLabel,
  customerDocLabel,
  formatCuit,
  voucherNumberLabel,
  type InvoicePrint
} from "../invoicing/invoicing-view";

// Armado de los tickets para la impresora térmica (bytes ESC/POS). Funciones
// puras: reciben todo lo que necesitan, no leen el estado de la pantalla.

export function buildReceiptTicket(receiptToPrint: ReceiptState, branchName?: string): Uint8Array {
  const settings = getThermalPrintSettings();
  const t = new TicketBuilder();
  if (settings.font !== "auto") t.font(settings.font);
  t.bodySize(settings, true);
  if (receiptToPrint.invoice) {
    invoiceHeader(t, receiptToPrint.invoice, settings.lineWidth, settings.font === "b" ? "b" : "a");
  } else {
    t.align("center").bold(true).line("COMPROBANTE INTERNO").bold(false);
    // Sin factura, el papel lo tiene que decir (es lo que se lleva el cliente).
    t.line("NO VÁLIDO COMO FACTURA");
    if (branchName) t.line(branchName);
    t.align("left").separator("-", settings.lineWidth);
    t.line(new Date(receiptToPrint.soldAt).toLocaleString("es-AR"));
    t.separator("-", settings.lineWidth);
  }
  for (const item of receiptToPrint.items) {
    const lineTotal = item.quantity * item.unitPrice - item.discountAmount;
    t.line(item.name);
    t.line(`  ${item.quantity} ${UNIT_LABELS[item.unit]} x ${formatMoney(item.unitPrice)} = ${formatMoney(lineTotal)}`);
  }
  t.separator("-", settings.lineWidth);
  if (receiptToPrint.saleDiscount > 0) t.line(`Descuento: -${formatMoney(receiptToPrint.saleDiscount)}`);
  if (receiptToPrint.saleSurcharge > 0) t.line(`Recargo: +${formatMoney(receiptToPrint.saleSurcharge)}`);
  t.bodySize(settings, false);
  t.bold(true).doubleSize(true).line(`TOTAL ${formatMoney(receiptToPrint.total)}`).doubleSize(false).bold(false);
  t.bodySize(settings, true);
  if (receiptToPrint.paymentSummary) t.line(`Pago: ${receiptToPrint.paymentSummary}`);
  if (receiptToPrint.amountTendered !== null) {
    t.line(`Recibido: ${formatMoney(receiptToPrint.amountTendered)}  Vuelto: ${formatMoney(Math.max(receiptToPrint.change ?? 0, 0))}`);
  }
  if (receiptToPrint.invoice) invoiceFooter(t, receiptToPrint.invoice, settings.lineWidth);
  t.feed(1).align("center").line("Gracias por su compra");
  t.bodySize(settings, false);
  t.cut();
  return t.build();
}

/** Encabezado de factura (RG 1415): tipo y código, emisor, número, fecha y cliente. */
function invoiceHeader(t: TicketBuilder, inv: InvoicePrint, width: number, bodyFont: "a" | "b") {
  const voucher = VOUCHER_NAME[inv.voucherType];
  t.align("center").bold(true).line(voucher?.name ?? `FACTURA ${inv.letter}`).bold(false);
  t.line(`COD. ${voucher?.code ?? ""} - ORIGINAL`);
  if (inv.issuer.tradeName) t.doubleSize(true).bold(true).line(inv.issuer.tradeName).bold(false).doubleSize(false);
  // Datos del titular con la letra chica de la impresora (obligatorios, pero sin ocupar el ticket).
  t.font("b");
  if (inv.issuer.tradeName) t.line(inv.issuer.businessName);
  else t.bold(true).line(inv.issuer.businessName).bold(false);
  if (inv.issuer.address) t.line(inv.issuer.address);
  t.line(`CUIT ${formatCuit(inv.issuer.cuit)}`);
  t.line(inv.issuer.taxCondition === "monotributo" ? "Responsable Monotributo" : "IVA Responsable Inscripto");
  if (inv.issuer.grossIncomeNumber) t.line(`IIBB ${inv.issuer.grossIncomeNumber}`);
  if (inv.issuer.activityStart) t.line(`Inicio de actividades ${arDateLabel(inv.issuer.activityStart)}`);
  t.font(bodyFont);
  t.align("left").separator("-", width);
  t.line(`Nro ${voucherNumberLabel(inv.pointOfSale, inv.number)}`);
  t.line(`Fecha ${arDateLabel(inv.issuedOn)}`);
  if (inv.relatedLabel) t.line(`Anula: ${inv.relatedLabel}`);
  t.separator("-", width);
  t.line(CUSTOMER_CONDITION_LABEL[inv.customer.taxCondition]);
  const doc = customerDocLabel(inv.customer.docType, inv.customer.docNumber);
  if (doc) t.line(doc);
  if (inv.customer.name) t.line(inv.customer.name);
  t.separator("-", width);
}

/** Pie de factura: IVA (A: discriminado; B: contenido, Ley 27.743), CAE y QR. */
function invoiceFooter(t: TicketBuilder, inv: InvoicePrint, width: number) {
  t.separator("-", width);
  const rate = String(inv.vatRate).replace(".", ",");
  if (inv.letter === "A") {
    t.line(`Neto gravado: ${formatMoney(inv.net)}`);
    t.line(`IVA ${rate}%: ${formatMoney(inv.vat)}`);
  } else if (inv.letter === "B") {
    t.line(`IVA contenido (${rate}%): ${formatMoney(inv.vat)}`);
  }
  t.line(`CAE ${inv.cae}`);
  t.line(`Vto. CAE ${arDateLabel(inv.caeDue)}`);
  t.align("center").qr(inv.qrUrl).line("Comprobante autorizado por ARCA");
}

/** Ticket del cierre de turno para la térmica: total, arqueo, cada cuenta,
 * y el detalle de movimientos de caja, vales y pagos a proveedores para
 * que quede en papel qué salió de la caja durante el turno. */
export interface CloseTicketData {
  summary: CloseShiftResult | null;
  branchName?: string;
  accounts: TreasuryAccount[];
  adjustments: PosShiftAdjustment[];
  vales: PosShiftVale[];
  supplierPayments: PosShiftSupplierPayment[];
}

export function buildCloseTicket({ summary, branchName, accounts, adjustments, vales, supplierPayments }: CloseTicketData): Uint8Array {
  const settings = getThermalPrintSettings();
  const width = settings.lineWidth;
  const row = (left: string, right: string) => {
    const room = Math.max(width - right.length - 1, 1);
    return left.slice(0, room).padEnd(room) + " " + right;
  };
  const t = new TicketBuilder();
  if (settings.font !== "auto") t.font(settings.font);
  t.bodySize(settings, true);
  t.align("center").bold(true).line("CIERRE DE TURNO").bold(false);
  if (branchName) t.line(branchName);
  t.align("left").separator("-", width);
  t.line(new Date().toLocaleString("es-AR"));
  if (summary) {
    t.separator("-", width);
    t.bold(true).line(row("Total del turno", formatMoney(summary.total))).bold(false);
    t.line("ARQUEO DE EFECTIVO");
    if (summary.breakdown) {
      t.line(row("Fondo inicial", formatMoney(summary.breakdown.openingCash)));
      t.line(row("+ Ventas efectivo", formatMoney(summary.breakdown.cashSales)));
      if (summary.breakdown.cashInflows > 0) t.line(row("+ Ingresos de caja", formatMoney(summary.breakdown.cashInflows)));
      t.line(row("- Salidas efectivo", formatMoney(summary.breakdown.cashOutflows)));
    }
    t.line(row("Esperado", formatMoney(summary.expectedCash)));
    if (summary.countedCash !== null) {
      t.line(row("Contado", formatMoney(summary.countedCash)));
      t.bold(true).line(row("Diferencia", formatMoney(summary.difference ?? 0))).bold(false);
    } else {
      t.line("Sin conteo de efectivo.");
    }
    if (summary.byAccount.length > 0) {
      t.separator("-", width);
      t.line("POR CUENTA");
      summary.byAccount.forEach((r) => {
        t.line(row(accounts.find((a) => a.id === r.accountId)?.name ?? "Cuenta", formatMoney(r.amount)));
      });
    }
  }
  if (adjustments.length > 0) {
    t.separator("-", width);
    t.line("MOVIMIENTOS DE CAJA");
    adjustments.forEach((a) => {
      const kind = a.movementType === "transferencia" ? "Traspaso" : a.direction === "in" ? "Ingreso" : "Egreso";
      const hour = new Date(a.createdAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
      t.line(row(hour + " " + kind, (a.direction === "in" ? "" : "-") + formatMoney(a.amount)));
      if (a.notes) t.line("  " + a.notes);
    });
    const totalOut = adjustments.filter((a) => a.direction === "out").reduce((sum, a) => sum + a.amount, 0);
    t.bold(true).line(row("Total sacado", formatMoney(totalOut))).bold(false);
  }
  if (vales.length > 0) {
    t.separator("-", width);
    t.line("VALES A EMPLEADOS");
    vales.forEach((v) => {
      t.line(row(v.employeeName, formatMoney(v.amount)));
      if (v.detail) t.line("  " + v.detail);
    });
    t.bold(true).line(row("Total vales", formatMoney(vales.reduce((sum, v) => sum + v.amount, 0)))).bold(false);
  }
  if (supplierPayments.length > 0) {
    t.separator("-", width);
    t.line("PAGOS A PROVEEDORES");
    supplierPayments.forEach((p) => {
      t.line(row(p.supplierName, formatMoney(p.amount)));
      if (p.notes) t.line("  " + p.notes);
    });
    t.bold(true).line(row("Total pagos", formatMoney(supplierPayments.reduce((sum, p) => sum + p.amount, 0)))).bold(false);
  }
  t.separator("-", width);
  t.feed(3);
  t.align("center").line("Firma: _______________________");
  t.bodySize(settings, false);
  t.cut();
  return t.build();
}

export function buildMovementTicket(mov: MovementReceiptState, branchName?: string): Uint8Array {
  const settings = getThermalPrintSettings();
  const t = new TicketBuilder();
  if (settings.font !== "auto") t.font(settings.font);
  t.bodySize(settings, true);
  t.align("center").bold(true).line(mov.title).bold(false);
  if (branchName) t.line(branchName);
  t.align("left").separator("-", settings.lineWidth);
  t.line(new Date(mov.date).toLocaleString("es-AR"));
  t.separator("-", settings.lineWidth);
  t.line(`Cuenta: ${mov.accountName}`);
  if (mov.counterpartName) t.line(`${mov.counterpartLabel}: ${mov.counterpartName}`);
  if (mov.detail) t.line(mov.detail);
  t.separator("-", settings.lineWidth);
  t.bodySize(settings, false);
  t.bold(true).doubleSize(true).line(`MONTO ${formatMoney(mov.amount)}`).doubleSize(false).bold(false);
  t.bodySize(settings, true);
  t.feed(3);
  t.align("center").line("Firma: _______________________");
  t.line("Aclaración y DNI:");
  t.bodySize(settings, false);
  t.cut();
  return t.build();
}
