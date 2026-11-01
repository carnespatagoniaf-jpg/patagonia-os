import { useState } from "react";
import { localDateIso } from "../shifts/format";
import { daySummary, dueWithinHour, isOpen, type CustomerOrder } from "./orders-logic";

const DISMISS_KEY = "patagonia-orders-alert-dismissed";

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Aviso de pedidos arriba de todas las pantallas (Inicio, Mostrador, …): cuántos hay que entregar hoy y el horario
 * del primero, cuántos hay mañana, y "en menos de una hora retira…". Es una franja chica que no tapa la venta. Se
 * puede cerrar; vuelve a aparecer si entra un pedido nuevo o si falta menos de una hora para un retiro.
 */
export function OrdersAlert({ today, tomorrow, now, onOpen }: { today: CustomerOrder[]; tomorrow: CustomerOrder[]; now: Date; onOpen: () => void }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const day = localDateIso(now);
  const summary = daySummary(today, day, now);
  const tomorrowOpen = tomorrow.filter(isOpen).length;
  const soon = dueWithinHour(today, day, now);
  // Lo que se cerró queda cerrado hasta que cambie algo: otro día, otro pedido u otro retiro cercano.
  const signature = `${day}|${summary.open}|${tomorrowOpen}|${soon.map((o) => o.id).join(",")}`;

  if (summary.open === 0 && tomorrowOpen === 0) return null;
  if (dismissed === signature) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, signature);
    } catch {
      // sin localStorage se cierra solo en esta sesión
    }
    setDismissed(signature);
  }

  const parts: string[] = [];
  if (summary.open > 0) {
    parts.push(`Hoy tenés ${summary.open} ${summary.open === 1 ? "pedido" : "pedidos"} para retirar${summary.firstTime ? `; el primero es a las ${summary.firstTime}` : ""}.`);
  }
  if (tomorrowOpen > 0) parts.push(`Mañana: ${tomorrowOpen} ${tomorrowOpen === 1 ? "pedido" : "pedidos"}.`);

  return (
    <div className={`orders-alert no-print${soon.length > 0 ? " soon" : ""}`} role="status">
      <span>
        {soon.length > 0 && (
          <strong>
            En menos de una hora retira{soon.length > 1 ? "n" : ""} {soon.map((o) => `${o.customerName} (${o.pickupTime})`).join(", ")}.{" "}
          </strong>
        )}
        {parts.join(" ")}
        {summary.overdue > 0 && <strong> {summary.overdue === 1 ? "Uno ya pasó de hora." : `${summary.overdue} ya pasaron de hora.`}</strong>}
      </span>
      <span className="orders-alert-actions">
        <button className="secondary" onClick={onOpen}>Ver pedidos</button>
        <button className="secondary" aria-label="Cerrar aviso" onClick={dismiss}>✕</button>
      </span>
    </div>
  );
}
