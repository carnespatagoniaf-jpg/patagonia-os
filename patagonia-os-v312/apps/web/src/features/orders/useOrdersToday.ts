import { useCallback, useEffect, useState } from "react";
import { addDaysIso, localDateIso } from "../shifts/format";
import type { CustomerOrder } from "./orders-logic";
import { listOrders } from "./orders-service";

/** Aviso a las demás pantallas (contador del menú, aviso de arriba) de que se guardó o cambió un pedido. */
export const ORDERS_CHANGED_EVENT = "patagonia-orders-changed";

export function notifyOrdersChanged(): void {
  window.dispatchEvent(new Event(ORDERS_CHANGED_EVENT));
}

/**
 * Pedidos de hoy y de mañana de la sucursal, para el contador del menú y los avisos. Se refresca cada minuto, al
 * volver a la pestaña y cuando esta misma PC guarda un pedido: así lo que carga otra caja de la sucursal aparece
 * en menos de un minuto sin agregar nada nuevo (el sistema no usa Realtime en ningún lado).
 */
export function useOrdersToday(branchId: string | null, enabled: boolean) {
  const [today, setToday] = useState<CustomerOrder[]>([]);
  const [tomorrow, setTomorrow] = useState<CustomerOrder[]>([]);
  const [now, setNow] = useState(() => new Date());

  const reload = useCallback(async () => {
    setNow(new Date());
    if (!enabled || !branchId) {
      setToday([]);
      setTomorrow([]);
      return;
    }
    const day = localDateIso();
    try {
      const orders = await listOrders(branchId, day, addDaysIso(day, 1));
      setToday(orders.filter((o) => o.pickupDate === day));
      setTomorrow(orders.filter((o) => o.pickupDate !== day));
    } catch {
      // Un aviso nunca rompe la pantalla: se reintenta en el próximo minuto.
    }
  }, [branchId, enabled]);

  useEffect(() => {
    void reload();
    if (!enabled) return;
    const timer = window.setInterval(() => void reload(), 60_000);
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    window.addEventListener(ORDERS_CHANGED_EVENT, onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(ORDERS_CHANGED_EVENT, onFocus);
    };
  }, [reload, enabled]);

  return { today, tomorrow, now, reload };
}
