// Pedidos de clientes (migración 187): lógica pura, sin Supabase (testeada en orders-logic.test.ts).
// Es solo informativo: nada de acá toca stock, caja ni Tesorería.

export type OrderStatus = "pendiente" | "listo" | "entregado" | "cancelado";
export type OrderUnit = "kg" | "unit" | "box";

export interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  unit: OrderUnit;
  notes: string | null;
}

export interface CustomerOrder {
  id: string;
  branchId: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  /** YYYY-MM-DD */
  pickupDate: string;
  /** HH:MM o null (sin hora: "en el día") */
  pickupTime: string | null;
  notes: string | null;
  total: number | null;
  deposit: number;
  status: OrderStatus;
  createdAt: string;
  items: OrderItem[];
}

export const STATUS_LABELS: Record<OrderStatus, string> = {
  pendiente: "Pendiente",
  listo: "Listo",
  entregado: "Entregado",
  cancelado: "Cancelado"
};

/** Pedidos que todavía hay que preparar o entregar (cuentan para avisos y planificación). */
export function isOpen(order: Pick<CustomerOrder, "status">): boolean {
  return order.status === "pendiente" || order.status === "listo";
}

/** Paso de los botones − / +: medio kilo para lo que va por kilo, uno para unidades y cajas. */
export function stepFor(unit: OrderUnit): number {
  return unit === "kg" ? 0.5 : 1;
}

/** Suma o resta un paso sin bajar de cero ni dejar decimales sueltos (0.1 + 0.2). */
export function stepQuantity(quantity: number, unit: OrderUnit, direction: 1 | -1): number {
  const next = Math.round((quantity + direction * stepFor(unit)) * 1000) / 1000;
  return next < 0 ? 0 : next;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 }).format(value);
}

/** "2,5 kg Asado", "3 Morcilla", "1 caja Hamburguesas". */
export function itemLabel(item: Pick<OrderItem, "quantity" | "unit" | "productName">): string {
  if (item.unit === "kg") return `${formatNumber(item.quantity)} kg ${item.productName}`;
  if (item.unit === "box") return `${formatNumber(item.quantity)} ${item.quantity === 1 ? "caja" : "cajas"} ${item.productName}`;
  return `${formatNumber(item.quantity)} ${item.productName}`;
}

/** Lo que falta cobrar (total − seña). Sin total: null (no se sabe). */
export function balanceDue(order: Pick<CustomerOrder, "total" | "deposit">): number | null {
  if (order.total === null) return null;
  return Math.max(0, order.total - order.deposit);
}

/** "Seña $10.000 ya recibida" / "Sin seña" / "Pagado". */
export function depositLabel(order: Pick<CustomerOrder, "total" | "deposit">, money: (n: number) => string): string {
  if (order.total !== null && order.total > 0 && order.deposit >= order.total) return "Pagado";
  if (order.deposit > 0) return `Seña ${money(order.deposit)} ya recibida`;
  return "Sin seña";
}

/** Minutos desde las 00:00 de una hora "HH:MM" (o "HH:MM:SS"). */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map((part) => Number(part));
  return (h || 0) * 60 + (m || 0);
}

function nowMinutes(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** Orden del día: primero por hora (los "en el día" al final), después por cuándo se cargó. */
export function sortForDay<T extends Pick<CustomerOrder, "pickupTime" | "createdAt">>(orders: T[]): T[] {
  return [...orders].sort((a, b) => {
    const ta = a.pickupTime ? timeToMinutes(a.pickupTime) : 24 * 60;
    const tb = b.pickupTime ? timeToMinutes(b.pickupTime) : 24 * 60;
    return ta - tb || a.createdAt.localeCompare(b.createdAt);
  });
}

/** Vencido: era para hoy (o antes), ya pasó la hora y no se entregó. Un pedido de un día anterior sin entregar también. */
export function isOverdue(order: Pick<CustomerOrder, "status" | "pickupDate" | "pickupTime">, today: string, now: Date): boolean {
  if (!isOpen(order)) return false;
  if (order.pickupDate < today) return true;
  if (order.pickupDate > today || !order.pickupTime) return false;
  return timeToMinutes(order.pickupTime) < nowMinutes(now);
}

export interface DaySummary {
  /** Pendientes + listos para hoy. */
  open: number;
  /** Hora del primero que todavía no pasó (o del primero vencido si ya pasaron todos), HH:MM. */
  firstTime: string | null;
  overdue: number;
}

export function daySummary(orders: CustomerOrder[], today: string, now: Date): DaySummary {
  const open = sortForDay(orders.filter((o) => o.pickupDate === today && isOpen(o)));
  const upcoming = open.find((o) => o.pickupTime && timeToMinutes(o.pickupTime) >= nowMinutes(now));
  const firstTimed = upcoming ?? open.find((o) => o.pickupTime);
  return {
    open: open.length,
    firstTime: firstTimed?.pickupTime?.slice(0, 5) ?? null,
    overdue: open.filter((o) => isOverdue(o, today, now)).length
  };
}

/** Texto del aviso de arriba de la pantalla de hoy. */
export function dayBannerText(summary: DaySummary, isToday: boolean): string {
  if (summary.open === 0) return isToday ? "No quedan pedidos pendientes para hoy." : "No hay pedidos pendientes para este día.";
  const count = `${summary.open} ${summary.open === 1 ? "pedido" : "pedidos"}`;
  const head = isToday ? `Hoy tenés ${count} para retirar.` : `Hay ${count} para retirar.`;
  return summary.firstTime ? `${head} El primero es a las ${summary.firstTime}.` : head;
}

/** Pedidos de hoy que retiran en la próxima hora y todavía no están listos ni entregados (aviso "una hora antes"). */
export function dueWithinHour(orders: CustomerOrder[], today: string, now: Date): CustomerOrder[] {
  const minutes = nowMinutes(now);
  return sortForDay(
    orders.filter((o) => {
      if (o.status !== "pendiente" || o.pickupDate !== today || !o.pickupTime) return false;
      const diff = timeToMinutes(o.pickupTime) - minutes;
      return diff >= 0 && diff <= 60;
    })
  );
}

export interface PlanLine {
  productId: string;
  productName: string;
  unit: OrderUnit;
  quantity: number;
  orders: number;
}

export interface PlanResult {
  orders: number;
  /** Por kilo, de más a menos. */
  byKg: PlanLine[];
  /** Por unidad o caja, de más a menos. Nunca se mezcla con los kilos. */
  byUnit: PlanLine[];
}

/** Planificación: suma por producto de los pedidos abiertos de los días elegidos. Kilos y unidades por separado. */
export function planTotals(orders: CustomerOrder[], dates: string[]): PlanResult {
  const wanted = new Set(dates);
  const chosen = orders.filter((o) => wanted.has(o.pickupDate) && isOpen(o));
  const lines = new Map<string, PlanLine & { orderIds: Set<string> }>();
  for (const order of chosen) {
    for (const item of order.items) {
      const key = `${item.productId}|${item.unit}`;
      const line = lines.get(key) ?? { productId: item.productId, productName: item.productName, unit: item.unit, quantity: 0, orders: 0, orderIds: new Set<string>() };
      line.quantity = Math.round((line.quantity + item.quantity) * 1000) / 1000;
      line.orderIds.add(order.id);
      line.orders = line.orderIds.size;
      lines.set(key, line);
    }
  }
  const all = [...lines.values()].map(({ orderIds: _ids, ...line }) => line);
  const byQuantity = (a: PlanLine, b: PlanLine) => b.quantity - a.quantity || a.productName.localeCompare(b.productName, "es");
  return {
    orders: chosen.length,
    byKg: all.filter((l) => l.unit === "kg").sort(byQuantity),
    byUnit: all.filter((l) => l.unit !== "kg").sort(byQuantity)
  };
}

/** Cantidad de pedidos abiertos por día (para marcar los días pesados en Planificación). */
export function openCountByDate(orders: CustomerOrder[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of orders) if (isOpen(o)) counts[o.pickupDate] = (counts[o.pickupDate] ?? 0) + 1;
  return counts;
}

/** "sábado 24/12" para títulos y papelitos. */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const weekday = d.toLocaleDateString("es-AR", { weekday: "long" });
  return `${weekday} ${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

export interface OrderDraftItem {
  productId: string;
  productName: string;
  unit: OrderUnit;
  quantity: number;
  notes: string;
}

/** Lo mínimo para guardar: nombre y al menos un producto con cantidad. Devuelve el error o null. */
export function validateDraft(draft: { customerName: string; pickupDate: string; items: OrderDraftItem[]; total: number | null; deposit: number }): string | null {
  if (!draft.customerName.trim()) return "Poné el nombre del cliente.";
  if (!draft.pickupDate) return "Elegí el día de retiro.";
  if (!draft.items.some((i) => i.quantity > 0)) return "Agregá al menos un producto.";
  if (draft.deposit < 0 || (draft.total !== null && draft.total < 0)) return "Los montos no pueden ser negativos.";
  if (draft.total !== null && draft.deposit > draft.total) return "La seña no puede ser mayor que el total.";
  return null;
}
