import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { formatMoney } from "../shifts/format";
import { isAgentEnabled } from "../sale/printer-agent";
import { isThermalPrinterPaired, printBytes } from "../sale/thermal-printer";
import { balanceDue, dayLabel, itemLabel, type CustomerOrder } from "./orders-logic";
import { buildOrderTicket } from "./orders-ticket";

/** El papelito en papel (vista previa / impresora común): 80 mm de ancho, y en una hoja A4 sale arriba a la izquierda. */
export function OrderPaper({ order, branchName }: { order: CustomerOrder; branchName?: string }) {
  const due = balanceDue(order);
  return (
    <div className="order-paper">
      {branchName && <p className="order-paper-branch">{branchName}</p>}
      <p className="order-paper-title">PEDIDO PARA RETIRAR</p>
      <p className="order-paper-day">{dayLabel(order.pickupDate)}</p>
      {order.pickupTime && <p className="order-paper-time">{order.pickupTime} hs</p>}
      <div className="order-paper-block">
        <strong>{order.customerName}</strong>
        {order.customerPhone && <div>Tel: {order.customerPhone}</div>}
      </div>
      <ul className="order-paper-items">
        {order.items.map((item, i) => (
          <li key={`${item.productId}-${i}`}>
            {itemLabel(item)}
            {item.notes && <small> · {item.notes}</small>}
          </li>
        ))}
      </ul>
      {order.notes && <p className="order-paper-block">Nota: {order.notes}</p>}
      {(order.total !== null || order.deposit > 0) && (
        <div className="order-paper-block">
          {order.total !== null && <div>Total: {formatMoney(order.total)}</div>}
          <div>Seña: {formatMoney(order.deposit)}</div>
          {due !== null && <div className="order-paper-due">A COBRAR {formatMoney(due)}</div>}
        </div>
      )}
      <p className="order-paper-foot">Pedido guardado en el sistema</p>
    </div>
  );
}

/** Imprime en papel sin tocar el resto de la pantalla (portal + .print-area, como el Remito R). */
export function OrderPaperPrint({ order, branchName, onDone }: { order: CustomerOrder; branchName?: string; onDone: () => void }) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const t = window.setTimeout(() => {
      window.print();
      doneRef.current();
    }, 50);
    return () => window.clearTimeout(t);
  }, [order]);
  return createPortal(
    <div className="print-area order-print-area">
      <OrderPaper order={order} branchName={branchName} />
    </div>,
    document.body
  );
}

/**
 * Imprime el papelito con el mismo mecanismo que los tickets de Mostrador: si esta PC tiene la térmica (programa de
 * impresión o USB directo) va a la térmica; si no, o si falla, devuelve false y la pantalla abre la impresión en papel.
 */
export async function printOrderOnThermal(order: CustomerOrder, branchName?: string): Promise<boolean> {
  const hasThermal = isAgentEnabled() || (await isThermalPrinterPaired().catch(() => false));
  if (!hasThermal) return false;
  try {
    await printBytes(buildOrderTicket(order, branchName));
    return true;
  } catch {
    return false;
  }
}
