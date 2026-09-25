import { forwardRef, Fragment } from "react";
import type { TreasuryAccount } from "@patagonia/domain";
import type { PosShiftVale } from "../employees/employees-service";
import type { CloseShiftResult, PosShiftAdjustment, PosShiftSale, PosShiftSupplierPayment } from "./pos-shift-service";
import { formatMoney } from "../shifts/format";
import { parseAmount } from "../../lib/money";
import { isThermalPrintSupported } from "./thermal-printer";
import { UNIT_LABELS, type MovementReceiptState, type ReceiptState } from "./sale-model";

// Comprobantes que se muestran (y se imprimen) debajo de Mostrador: el último
// comprobante de venta, el de un movimiento de caja/pago/vale y el detalle del
// turno cerrado. Son solo vista: reciben todo por props.

export function ReceiptView({ receipt, branchName, thermalPrintBusy, onPrint, onThermalPrint }: {
  receipt: ReceiptState;
  branchName: string;
  thermalPrintBusy: boolean;
  onPrint: (copies?: number) => void;
  onThermalPrint: () => void;
}) {
  return (
    <section className="panel print-area receipt-ticket" style={{ marginTop: 18 }}>
      <div className="panel-title">
        <h2>Último comprobante</h2>
        <div className="no-print ticket-actions">
          <button className="ticket-action-btn" onClick={() => onPrint()}>Reimprimir</button>
          <button className="ticket-action-btn" onClick={() => onPrint(2)}>2 copias</button>
          {isThermalPrintSupported() && (
            <button className="ticket-action-btn" disabled={thermalPrintBusy} onClick={onThermalPrint}>
              {thermalPrintBusy ? "Imprimiendo…" : "Térmica"}
            </button>
          )}
        </div>
      </div>

      <div className="ticket-header">
        <strong>{branchName}</strong>
        <p>Comprobante interno · no válido como factura</p>
        <p>{new Date(receipt.soldAt).toLocaleString("es-AR")}</p>
        {receipt.pending && <p className="no-print" style={{ color: "#8a4b00", fontWeight: 700 }}>⏳ Guardada sin conexión, pendiente de subir</p>}
      </div>

      <div className="ticket-rule" />
      <div className="ticket-items">
        {receipt.items.map((item, idx) => (
          <div className="ticket-item" key={idx}>
            <span className="ticket-item-name">{item.name}</span>
            <span className="ticket-item-detail">
              <span>{item.quantity} {UNIT_LABELS[item.unit]} x {formatMoney(item.unitPrice)}</span>
              <b>{formatMoney(item.quantity * item.unitPrice - item.discountAmount)}</b>
            </span>
          </div>
        ))}
      </div>
      <div className="ticket-rule" />

      {(receipt.saleDiscount > 0 || receipt.saleSurcharge > 0) && (
        <p className="ticket-line-sm">
          {receipt.saleDiscount > 0 && `Descuento -${formatMoney(receipt.saleDiscount)} `}
          {receipt.saleSurcharge > 0 && `Recargo +${formatMoney(receipt.saleSurcharge)}`}
        </p>
      )}
      <div className="ticket-total"><span>TOTAL</span><strong>{formatMoney(receipt.total)}</strong></div>
      <p className="ticket-line-sm">Pago: {receipt.paymentSummary}</p>
      {receipt.amountTendered !== null && (
        <p className="ticket-line-sm">
          Recibido {formatMoney(receipt.amountTendered)} · Vuelto {formatMoney(Math.max(receipt.change ?? 0, 0))}
        </p>
      )}
      <p className="ticket-footer print-only-header">Gracias por su compra</p>
    </section>
  );
}

export const MovementReceiptView = forwardRef<HTMLDivElement, {
  movementReceipt: MovementReceiptState;
  branchName: string;
  onPrint: () => void;
  onClose: () => void;
}>(function MovementReceiptView({ movementReceipt, branchName, onPrint, onClose }, ref) {
  return (
    <section ref={ref} className="panel print-area receipt-ticket" style={{ marginTop: 18 }}>
      <div className="panel-title">
        <h2>Comprobante</h2>
        <div className="no-print ticket-actions">
          <button className="ticket-action-btn" onClick={() => onPrint()}>Imprimir</button>
          <button className="ticket-action-btn" onClick={onClose}>Cerrar</button>
        </div>
      </div>

      <div className="ticket-header">
        <strong>{branchName}</strong>
        <p>{movementReceipt.title}</p>
        <p>{new Date(movementReceipt.date).toLocaleString("es-AR")}</p>
      </div>

      <div className="ticket-rule" />
      <p className="ticket-line-sm">Cuenta: {movementReceipt.accountName}</p>
      {movementReceipt.counterpartName && (
        <p className="ticket-line-sm">{movementReceipt.counterpartLabel}: {movementReceipt.counterpartName}</p>
      )}
      <p className="ticket-line-sm">{movementReceipt.detail}</p>
      <div className="ticket-total"><span>MONTO</span><strong>{formatMoney(movementReceipt.amount)}</strong></div>
      <div className="ticket-rule" />

      <div style={{ marginTop: 48 }}>
        <p style={{ borderTop: "1px solid #000", paddingTop: 4, textAlign: "center", margin: 0 }}>Firma</p>
        <p className="muted" style={{ textAlign: "center", fontSize: 12, margin: "2px 0 0" }}>Aclaración y DNI</p>
      </div>
    </section>
  );
});

export function CloseSummaryView({ summary, accounts, adjustments, vales, supplierPayments, detail, reconcileInput, onReconcileChange, thermalPrintBusy, onThermalPrint, onPrint }: {
  summary: CloseShiftResult;
  accounts: TreasuryAccount[];
  adjustments: PosShiftAdjustment[];
  vales: PosShiftVale[];
  supplierPayments: PosShiftSupplierPayment[];
  detail: PosShiftSale[];
  reconcileInput: Record<string, string>;
  onReconcileChange: (next: Record<string, string>) => void;
  thermalPrintBusy: boolean;
  onThermalPrint: () => void;
  onPrint: () => void;
}) {
  return (
    <section className="panel print-area" style={{ marginTop: 18 }}>
      <div className="panel-title">
        <h2>Detalle del turno cerrado</h2>
        <div className="no-print" style={{ display: "flex", gap: 8 }}>
          {isThermalPrintSupported() && (
            <button className="secondary" disabled={thermalPrintBusy} onClick={onThermalPrint}>
              {thermalPrintBusy ? "Imprimiendo…" : "Ticket (térmica)"}
            </button>
          )}
          <button className="secondary" onClick={() => onPrint()}>Imprimir</button>
        </div>
      </div>
      <p className="muted print-only-header">Cerrado {new Date().toLocaleString("es-AR")}</p>
      <p><strong>Total del turno: {formatMoney(summary.total)}</strong></p>
      <div className="panel" style={{ padding: 14, marginBottom: 16 }}>
        <p className="muted" style={{ margin: 0, marginBottom: 6, fontWeight: 800, textTransform: "uppercase", fontSize: 12 }}>Arqueo de caja</p>
        {summary.breakdown && (
          <>
            <p style={{ margin: "4px 0" }}>Fondo inicial: <strong>{formatMoney(summary.breakdown.openingCash)}</strong></p>
            <p style={{ margin: "4px 0" }}>+ Ventas en efectivo: <strong>{formatMoney(summary.breakdown.cashSales)}</strong></p>
            {summary.breakdown.cashInflows > 0 && (
              <p style={{ margin: "4px 0" }}>+ Ingresos de caja: <strong>{formatMoney(summary.breakdown.cashInflows)}</strong></p>
            )}
            <p style={{ margin: "4px 0" }}>- Salidas de efectivo (vales, pagos, egresos): <strong>{formatMoney(summary.breakdown.cashOutflows)}</strong></p>
          </>
        )}
        <p style={{ margin: "4px 0" }}>Efectivo esperado: <strong>{formatMoney(summary.expectedCash)}</strong></p>
        {summary.breakdown && summary.breakdown.noncashOutflows > 0 && (
          <p className="num-negative" style={{ margin: "6px 0", fontWeight: 700 }}>
            Ojo: {formatMoney(summary.breakdown.noncashOutflows)} en vales/pagos/egresos de este turno se cargaron con una cuenta que no es de efectivo, por eso NO se restaron del efectivo esperado. Si esa plata salió del cajón, tiene que cargarse con la cuenta Efectivo.
          </p>
        )}
        {summary.countedCash !== null ? (
          <>
            <p style={{ margin: "4px 0" }}>Efectivo contado: <strong>{formatMoney(summary.countedCash)}</strong></p>
            <p style={{ margin: "4px 0" }}>
              Diferencia:{" "}
              <strong className={(summary.difference ?? 0) < 0 ? "num-negative" : (summary.difference ?? 0) > 0 ? "num-positive" : undefined}>
                {formatMoney(summary.difference ?? 0)}
              </strong>
            </p>
          </>
        ) : (
          <p className="muted" style={{ margin: "4px 0" }}>No se cargó el conteo de efectivo al cerrar.</p>
        )}
      </div>
      {summary.byAccount.length > 0 && (
        <table className="data-table" style={{ marginBottom: 16 }}>
          <thead>
            <tr>
              <th>Cuenta</th>
              <th className="num">Ventas</th>
              <th className="num">Monto</th>
              <th className="num no-print">Real (posnet/resumen)</th>
              <th className="num no-print">Diferencia</th>
            </tr>
          </thead>
          <tbody>
            {summary.byAccount.map((row) => {
              const account = accounts.find((a) => a.id === row.accountId);
              const cashRowCount = summary.byAccount.filter((r) => accounts.find((a) => a.id === r.accountId)?.paymentMethod === "cash").length;
              // Fila de efectivo: lo que se cuenta (caja fuerte) sale de las
              // ventas en efectivo MENOS lo que salió de esa plata -- vales,
              // pagos a proveedores y egresos que no fueron a la caja fuerte.
              // Sin esto la diferencia daba negativa por todo lo pagado.
              const isCashRow = account?.paymentMethod === "cash" && cashRowCount === 1 && summary.breakdown !== null;
              const otherOutflows = isCashRow
                ? adjustments
                    .filter((a) => a.direction === "out" && a.movementType === "ajuste" && a.accountName === account?.name && !/caja\s*f|fuerte/i.test(a.notes ?? ""))
                    .reduce((sum, a) => sum + a.amount, 0)
                : 0;
              const cashDeductions = isCashRow && summary.breakdown
                ? summary.breakdown.cashVales + summary.breakdown.cashSupplierPayments + otherOutflows
                : 0;
              const expectedAmount = row.amount - cashDeductions;
              const realInput = reconcileInput[row.accountId] ?? "";
              const realValue = realInput.trim() ? parseAmount(realInput) : null;
              const diff = realValue !== null && Number.isFinite(realValue) ? realValue - expectedAmount : null;
              return (
                <Fragment key={row.accountId}>
                <tr>
                  <td>{account?.name ?? row.accountId}</td>
                  <td className="num">{row.salesCount}</td>
                  <td className="num">{formatMoney(row.amount)}</td>
                  <td className="num no-print">
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="$"
                      style={{ width: 110, textAlign: "right" }}
                      value={realInput}
                      onChange={(e) => onReconcileChange({ ...reconcileInput, [row.accountId]: e.target.value })}
                    />
                  </td>
                  <td className="num no-print">
                    {diff !== null && (
                      <strong className={diff < 0 ? "num-negative" : diff > 0 ? "num-positive" : undefined}>
                        {formatMoney(diff)}
                      </strong>
                    )}
                  </td>
                </tr>
                {isCashRow && summary.breakdown && (
                  <tr className="no-print">
                    <td colSpan={5} className="muted" style={{ fontSize: 13 }}>
                      Lo que tiene que dar la caja fuerte: ventas {formatMoney(row.amount)}
                      {summary.breakdown.cashVales > 0 && ` − vales ${formatMoney(summary.breakdown.cashVales)}`}
                      {summary.breakdown.cashSupplierPayments > 0 && ` − pagos a proveedores ${formatMoney(summary.breakdown.cashSupplierPayments)}`}
                      {otherOutflows > 0 && ` − otras salidas ${formatMoney(otherOutflows)}`}
                      {" = "}<strong>{formatMoney(expectedAmount)}</strong>. Los movimientos con "caja fuerte" en el motivo se cuentan como depósito, no como salida.
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {adjustments.length > 0 && (
        <div className="panel" style={{ padding: 14, marginBottom: 16 }}>
          <p className="muted" style={{ margin: 0, marginBottom: 6, fontWeight: 800, textTransform: "uppercase", fontSize: 12 }}>
            Movimientos de caja del turno
          </p>
          <table className="data-table no-print">
            <thead>
              <tr><th>Hora</th><th>Tipo</th><th>Cuenta</th><th>Motivo</th><th className="num">Monto</th></tr>
            </thead>
            <tbody>
              {adjustments.map((adj) => (
                <tr key={adj.id}>
                  <td>{new Date(adj.createdAt).toLocaleTimeString("es-AR")}</td>
                  <td>{adj.movementType === "transferencia" ? "Traspaso" : adj.direction === "in" ? "Ingreso" : "Egreso"}</td>
                  <td>{adj.accountName}</td>
                  <td>{adj.notes ?? "-"}</td>
                  <td className="num">{adj.direction === "in" ? "" : "-"}{formatMoney(adj.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="print-only-list">
            {adjustments.map((adj) => (
              <div key={adj.id}>
                <div className="print-row">
                  <span className="print-row-label">
                    {new Date(adj.createdAt).toLocaleTimeString("es-AR")} · {adj.movementType === "transferencia" ? "Traspaso" : adj.direction === "in" ? "Ingreso" : "Egreso"} · {adj.accountName}
                  </span>
                  <span className="print-row-amount">{adj.direction === "in" ? "" : "-"}{formatMoney(adj.amount)}</span>
                </div>
                {adj.notes && <p className="print-row-detail">{adj.notes}</p>}
              </div>
            ))}
          </div>
          <p style={{ margin: "8px 0 0" }}>
            Total sacado de caja (egresos y traspasos):{" "}
            <strong>
              {formatMoney(adjustments.filter((a) => a.direction === "out").reduce((sum, a) => sum + a.amount, 0))}
            </strong>
          </p>
        </div>
      )}
      {vales.length > 0 && (
        <div className="panel" style={{ padding: 14, marginBottom: 16 }}>
          <p className="muted" style={{ margin: 0, marginBottom: 6, fontWeight: 800, textTransform: "uppercase", fontSize: 12 }}>
            Vales a empleados del turno
          </p>
          <table className="data-table no-print">
            <thead>
              <tr><th>Hora</th><th>Empleado</th><th>Detalle</th><th className="num">Monto</th></tr>
            </thead>
            <tbody>
              {vales.map((v) => (
                <tr key={v.id}>
                  <td>{new Date(v.createdAt).toLocaleTimeString("es-AR")}</td>
                  <td>{v.employeeName}</td>
                  <td>{v.detail || "-"}</td>
                  <td className="num">{formatMoney(v.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="print-only-list">
            {vales.map((v) => (
              <div key={v.id}>
                <div className="print-row">
                  <span className="print-row-label">{new Date(v.createdAt).toLocaleTimeString("es-AR")} · {v.employeeName}</span>
                  <span className="print-row-amount">{formatMoney(v.amount)}</span>
                </div>
                {v.detail && <p className="print-row-detail">{v.detail}</p>}
              </div>
            ))}
          </div>
          <p style={{ margin: "8px 0 0" }}>
            Total en vales: <strong>{formatMoney(vales.reduce((sum, v) => sum + v.amount, 0))}</strong>
          </p>
        </div>
      )}
      {supplierPayments.length > 0 && (
        <div className="panel" style={{ padding: 14, marginBottom: 16 }}>
          <p className="muted" style={{ margin: 0, marginBottom: 6, fontWeight: 800, textTransform: "uppercase", fontSize: 12 }}>
            Pagos a proveedores del turno
          </p>
          <table className="data-table no-print">
            <thead>
              <tr><th>Hora</th><th>Proveedor</th><th>Cuenta</th><th>Detalle</th><th className="num">Monto</th></tr>
            </thead>
            <tbody>
              {supplierPayments.map((p) => (
                <tr key={p.id}>
                  <td>{new Date(p.createdAt).toLocaleTimeString("es-AR")}</td>
                  <td>{p.supplierName}</td>
                  <td>{p.accountName}</td>
                  <td>{p.notes || "-"}</td>
                  <td className="num">{formatMoney(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="print-only-list">
            {supplierPayments.map((p) => (
              <div key={p.id}>
                <div className="print-row">
                  <span className="print-row-label">{new Date(p.createdAt).toLocaleTimeString("es-AR")} · {p.supplierName} · {p.accountName}</span>
                  <span className="print-row-amount">{formatMoney(p.amount)}</span>
                </div>
                {p.notes && <p className="print-row-detail">{p.notes}</p>}
              </div>
            ))}
          </div>
          <p style={{ margin: "8px 0 0" }}>
            Total en pagos a proveedores: <strong>{formatMoney(supplierPayments.reduce((sum, p) => sum + p.amount, 0))}</strong>
          </p>
        </div>
      )}
      <table className="data-table no-print">
        <thead>
          <tr><th>Hora</th><th>Producto</th><th className="num">Cant.</th><th className="num">Subtotal</th><th>Pago</th></tr>
        </thead>
        <tbody>
          {detail.flatMap((sale) =>
            sale.items.map((item, idx) => (
              <tr key={`${sale.id}-${idx}`}>
                <td>{idx === 0 ? new Date(sale.createdAt).toLocaleTimeString("es-AR") : ""}</td>
                <td>{item.productName}</td>
                <td className="num">{item.quantity} {UNIT_LABELS[item.unit]}</td>
                <td className="num">{formatMoney(item.lineTotal)}</td>
                <td>{idx === 0 ? sale.payments.map((p) => p.accountName).join(" + ") : ""}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="print-only-list">
        {detail.map((sale) => (
          <div key={sale.id} style={{ marginBottom: 6 }}>
            <div className="print-row">
              <span className="print-row-label">
                {new Date(sale.createdAt).toLocaleTimeString("es-AR")} · {sale.payments.map((p) => p.accountName).join(" + ")}
                {sale.voidedAt ? " · ANULADA" : ""}
              </span>
              <span className="print-row-amount">{formatMoney(sale.total)}</span>
            </div>
            {sale.items.map((item, idx) => (
              <p className="print-row-detail" key={idx}>
                {item.productName} ({item.quantity} {UNIT_LABELS[item.unit]}) {formatMoney(item.lineTotal)}
              </p>
            ))}
          </div>
        ))}
      </div>
      {detail.length === 0 && <p className="muted">No hubo ventas en este turno.</p>}
    </section>
  );
}
