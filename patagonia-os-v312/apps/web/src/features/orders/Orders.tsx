import { useCallback, useEffect, useMemo, useState } from "react";
import type { Product } from "@patagonia/domain";
import { isSupabaseConfigured } from "../../lib/supabase";
import { demoProducts } from "../../lib/demo-data";
import { useAuth } from "../auth/AuthProvider";
import { can, canAccessPage, ordersForOwner } from "../auth/permissions";
import { goToPage } from "../../lib/navigate";
import { orderToCharge, saveOrderToCharge } from "./order-to-charge";
import { useActiveBranch } from "../branches/BranchProvider";
import { listCustomers } from "../customers/customers-service";
import { listProductsForBranch } from "../inventory/inventory-service";
import { addDaysIso, formatMoney, localDateIso } from "../shifts/format";
import { OrderForm, type CustomerOption } from "./OrderForm";
import { OrderPaperPrint, printOrderOnThermal } from "./OrderPaper";
import { OrdersPlanning } from "./OrdersPlanning";
import {
  STATUS_LABELS,
  balanceDue,
  dayBannerText,
  dayLabel,
  daySummary,
  depositLabel,
  isOpen,
  isOverdue,
  itemLabel,
  sortForDay,
  type CustomerOrder,
  type OrderStatus
} from "./orders-logic";
import { listOrders, listOverdueBefore, setOrderStatus } from "./orders-service";
import { notifyOrdersChanged } from "./useOrdersToday";

// Pedidos de clientes (migración 187, pantalla a pedido 'pedidos'): el cuaderno de cada local, siempre de la sucursal
// elegida (nunca suma sucursales). Reemplaza el papelito que se pierde: el cajero
// anota el pedido, el día del retiro el sistema avisa y Planificación suma lo que hay que preparar. Solo informativo:
// no toca stock, caja, turnos ni Tesorería, y no muestra sumas de plata (solo lo que cobra cada pedido).

type Tab = "dia" | "planificacion";

/** Modo demostración (sin base): el catálogo de ejemplo más lo típico de un pedido. */
const DEMO_ORDER_PRODUCTS: Product[] = [
  ...demoProducts,
  ...([
    ["asado", "1", "Asado", "kg", 14900],
    ["matambre", "2", "Matambre", "kg", 16500],
    ["chorizo", "3", "Chorizo", "unit", 1800],
    ["morcilla", "4", "Morcilla", "unit", 1500],
    ["provoleta", "5", "Provoleta", "unit", 4200],
    ["carbon", "6", "Carbón bolsa 4 kg", "unit", 6500],
    ["entrana", "7", "Entraña", "kg", 19800],
    ["pechito", "8", "Pechito de cerdo", "kg", 9800]
  ] as const).map(([id, code, name, unit, price]) => ({ id, code, name, unit, cost: 0, priceRetail: price, stock: 0, minStock: 0 }))
];

const STATUS_BADGE: Record<OrderStatus, string> = { pendiente: "badge warn", listo: "badge brand", entregado: "badge ok", cancelado: "badge" };

export function Orders() {
  const { profile } = useAuth();
  const { branchId, branches } = useActiveBranch();
  const canEdit = can(profile, "orders.manage");
  // Pedidos para tienda (196): el pedido se cobra en Mostrador (baja stock y entra la plata) y queda entregado.
  const canCharge = canEdit && ordersForOwner(profile) && canAccessPage(profile, "sale");
  const [tab, setTab] = useState<Tab>("dia");
  const [day, setDay] = useState(() => localDateIso());
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [leftovers, setLeftovers] = useState<CustomerOrder[]>([]);
  const [showCancelled, setShowCancelled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<CustomerOrder | "new" | null>(null);
  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : DEMO_ORDER_PRODUCTS);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [printing, setPrinting] = useState<CustomerOrder | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const today = localDateIso(now);
  const branchName = branches.find((b) => b.id === branchId)?.name;

  const reload = useCallback(async () => {
    if (!branchId) return;
    setNow(new Date());
    try {
      const [dayOrders, old] = await Promise.all([
        listOrders(branchId, day, day),
        day === localDateIso() ? listOverdueBefore(branchId, day) : Promise.resolve([])
      ]);
      setOrders(dayOrders);
      setLeftovers(old);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudieron cargar los pedidos.");
    } finally {
      setLoading(false);
    }
  }, [branchId, day]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (!isSupabaseConfigured || !branchId) return;
    listProductsForBranch(branchId).then(setProducts).catch(() => setProducts([]));
    listCustomers()
      .then((list) => setCustomers(list.map((c) => ({ id: c.id, name: c.name, phone: c.phone ?? null }))))
      .catch(() => setCustomers([]));
  }, [branchId]);

  const visible = useMemo(() => sortForDay(orders.filter((o) => showCancelled || o.status !== "cancelado")), [orders, showCancelled]);
  const summary = daySummary(orders, day, now);
  const isToday = day === today;

  async function print(order: CustomerOrder) {
    if (await printOrderOnThermal(order, branchName)) {
      setMessage(`Papelito de ${order.customerName} impreso.`);
      return;
    }
    setPrinting(order);
  }

  async function changeStatus(order: CustomerOrder, status: OrderStatus) {
    if (status === "cancelado" && !window.confirm(`¿Cancelar el pedido de ${order.customerName}?`)) return;
    setBusyId(order.id);
    setMessage("");
    try {
      await setOrderStatus(order.id, status);
      await reload();
      notifyOrdersChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cambiar el pedido.");
    } finally {
      setBusyId(null);
    }
  }

  function chargeInSale(order: CustomerOrder) {
    try {
      saveOrderToCharge(orderToCharge(order));
    } catch {
      setMessage("Este navegador no deja pasar el pedido a Mostrador. Cargalo a mano y marcalo Entregado.");
      return;
    }
    goToPage("sale");
  }

  async function handleSaved(id: string, wantPrint: boolean, pickupDate: string) {
    const wasNew = editing === "new";
    setEditing(null);
    await reload();
    notifyOrdersChanged();
    setMessage(wasNew ? "Pedido guardado." : "Pedido actualizado.");
    if (wantPrint && branchId) {
      // Se vuelve a leer para imprimir exactamente lo que quedó guardado (puede ser de otro día que el que se ve).
      const saved = (await listOrders(branchId, pickupDate, pickupDate).catch(() => [])).find((o) => o.id === id);
      if (saved) await print(saved);
    }
  }

  function renderCard(order: CustomerOrder, showDate: boolean) {
    const overdue = isOverdue(order, today, now);
    const due = balanceDue(order);
    return (
      <li key={order.id} className={`order-card${overdue ? " overdue" : ""}${order.status === "cancelado" ? " cancelled" : ""}`}>
        <div className="order-card-time">
          {showDate && <small>{dayLabel(order.pickupDate)}</small>}
          <strong>{order.pickupTime ?? "En el día"}</strong>
          <span className={STATUS_BADGE[order.status]}>{STATUS_LABELS[order.status]}</span>
          {overdue && <span className="badge danger">Vencido</span>}
        </div>
        <div className="order-card-body">
          <div className="order-card-customer">
            <strong>{order.customerName}</strong>
            {order.customerPhone && <span className="muted"> · {order.customerPhone}</span>}
          </div>
          <div className="order-chips">
            {order.items.map((item, i) => (
              <span key={`${item.productId}-${i}`} className="order-chip" title={item.notes ?? undefined}>
                {itemLabel(item)}
                {item.notes && <em> · {item.notes}</em>}
              </span>
            ))}
          </div>
          {order.notes && <p className="order-card-note">{order.notes}</p>}
          {isOpen(order) && (
            <p className="order-card-money">
              {due !== null && <>A cobrar <strong>{formatMoney(due)}</strong> · </>}
              <span className="muted">{depositLabel(order, formatMoney)}</span>
            </p>
          )}
        </div>
        <div className="order-card-actions">
          {canEdit && order.status === "pendiente" && (
            <button disabled={busyId === order.id} onClick={() => void changeStatus(order, "listo")}>Marcar listo</button>
          )}
          {canCharge && isOpen(order) && order.items.length > 0 && (
            <button onClick={() => chargeInSale(order)}>Cobrar en Mostrador</button>
          )}
          {canEdit && isOpen(order) && (
            <button className={order.status === "listo" && !canCharge ? "" : "secondary"} disabled={busyId === order.id} onClick={() => void changeStatus(order, "entregado")}>
              Entregado
            </button>
          )}
          <button className="secondary" onClick={() => void print(order)}>Imprimir</button>
          {canEdit && isOpen(order) && (
            <>
              <button className="secondary" onClick={() => setEditing(order)}>Editar</button>
              <button className="secondary" disabled={busyId === order.id} onClick={() => void changeStatus(order, "cancelado")}>Cancelar</button>
            </>
          )}
        </div>
      </li>
    );
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <p className="eyebrow">PEDIDOS</p>
          <h1>Pedidos</h1>
          <p className="muted">
            {canCharge
              ? "Lo que te encargan para retirar. Cuando lo retiran, tocá \"Cobrar en Mostrador\": baja el stock, entra la plata y el pedido queda entregado."
              : "Lo que encargan los clientes para retirar otro día. Es solo informativo: no mueve la caja ni descuenta stock."}
          </p>
        </div>
        {canEdit && branchId && tab === "dia" && !editing && (
          <div>
            <button onClick={() => setEditing("new")}>+ Nuevo pedido</button>
          </div>
        )}
      </header>

      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 16px" }}>
        <button className={tab === "dia" ? "" : "secondary"} onClick={() => setTab("dia")}>Pedidos del día</button>
        <button className={tab === "planificacion" ? "" : "secondary"} onClick={() => setTab("planificacion")}>Planificación</button>
      </div>

      {!isSupabaseConfigured && <div className="message" style={{ marginBottom: 12 }}>Modo demostración: los pedidos se guardan solo en este navegador.</div>}
      {message && <div className="message" style={{ marginBottom: 12 }}>{message}</div>}

      {tab === "planificacion" ? (
        <OrdersPlanning branchId={branchId} branchName={branchName} />
      ) : (
        <>
          {editing && branchId && (
            <OrderForm
              key={editing === "new" ? "new" : editing.id}
              branchId={branchId}
              products={products}
              customers={customers}
              initial={editing === "new" ? null : editing}
              defaultDate={day < today ? today : day}
              onSaved={(id, wantPrint, date) => void handleSaved(id, wantPrint, date)}
              onCancel={() => setEditing(null)}
            />
          )}

          <section className="panel">
            <div className="panel-title">
              <h2 style={{ textTransform: "capitalize" }}>{isToday ? `Hoy, ${dayLabel(day)}` : dayLabel(day)}</h2>
              <div className="order-day-nav no-print">
                <button className="secondary" aria-label="Día anterior" onClick={() => setDay(addDaysIso(day, -1))}>←</button>
                <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
                <button className="secondary" aria-label="Día siguiente" onClick={() => setDay(addDaysIso(day, 1))}>→</button>
                {!isToday && <button className="secondary" onClick={() => setDay(today)}>Hoy</button>}
                <label className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                  <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
                  Ver cancelados
                </label>
              </div>
            </div>

            <div className={`order-banner${summary.open === 0 ? " empty" : ""}${summary.overdue > 0 ? " late" : ""}`}>
              {dayBannerText(summary, isToday)}
              {summary.overdue > 0 && ` ${summary.overdue === 1 ? "Uno ya pasó" : `${summary.overdue} ya pasaron`} de hora.`}
            </div>

            {loading ? (
              <p className="muted">Cargando…</p>
            ) : visible.length === 0 ? (
              <p className="muted">No hay pedidos para este día.</p>
            ) : (
              <ul className="order-list">{visible.map((o) => renderCard(o, false))}</ul>
            )}
          </section>

          {isToday && leftovers.length > 0 && (
            <section className="panel">
              <div className="panel-title">
                <h2>Quedaron sin entregar</h2>
                <span className="muted" style={{ fontSize: 13 }}>Pedidos de días anteriores: entregalos o cancelalos.</span>
              </div>
              <ul className="order-list">{sortForDay(leftovers).map((o) => renderCard(o, true))}</ul>
            </section>
          )}
        </>
      )}

      {printing && <OrderPaperPrint order={printing} branchName={branchName} onDone={() => setPrinting(null)} />}
    </div>
  );
}
