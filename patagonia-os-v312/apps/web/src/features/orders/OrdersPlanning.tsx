import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addDaysIso, localDateIso } from "../shifts/format";
import { dayLabel, openCountByDate, planTotals, type CustomerOrder, type PlanLine } from "./orders-logic";
import { listOrders } from "./orders-service";

const WINDOW_DAYS = 21;

function quantityText(line: PlanLine): string {
  const n = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 }).format(line.quantity);
  if (line.unit === "kg") return `${n} kg`;
  if (line.unit === "box") return `${n} ${line.quantity === 1 ? "caja" : "cajas"}`;
  return `${n} ${line.quantity === 1 ? "unidad" : "unidades"}`;
}

function PlanTable({ title, lines }: { title: string; lines: PlanLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="order-plan-block">
      <h3>{title}</h3>
      <div className="table-scroll">
        <table className="data-table no-stack">
          <thead>
            <tr><th>Producto</th><th className="num">Cantidad</th><th className="num">Pedidos</th></tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={`${l.productId}|${l.unit}`}>
                <td>{l.productName}</td>
                <td className="num"><strong>{quantityText(l)}</strong></td>
                <td className="num">{l.orders}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Planificación: qué hay que preparar (y comprar) en ESTE local para los días elegidos. Solo cantidades, nunca plata. */
export function OrdersPlanning({ branchId, branchName }: { branchId: string | null; branchName?: string }) {
  const [start, setStart] = useState(() => localDateIso());
  const [selected, setSelected] = useState<string[]>(() => [localDateIso()]);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [printing, setPrinting] = useState(false);
  const doneRef = useRef(() => setPrinting(false));

  const days = useMemo(() => Array.from({ length: WINDOW_DAYS }, (_, i) => addDaysIso(start, i)), [start]);

  useEffect(() => {
    if (!branchId) return;
    let alive = true;
    setLoading(true);
    listOrders(branchId, days[0], days[days.length - 1])
      .then((list) => {
        if (!alive) return;
        setOrders(list);
        setError("");
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : "No se pudieron cargar los pedidos."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [branchId, days]);

  useEffect(() => {
    if (!printing) return;
    const t = window.setTimeout(() => {
      window.print();
      doneRef.current();
    }, 50);
    return () => window.clearTimeout(t);
  }, [printing]);

  const counts = openCountByDate(orders);
  // Solo los días que se ven en la tira (al cambiar "Desde" los elegidos de antes quedan fuera).
  const chosen = selected.filter((d) => days.includes(d)).sort();
  const plan = planTotals(orders, chosen);
  const daysText = chosen.map(dayLabel).join(", ");

  function toggle(date: string) {
    setSelected((current) => (current.includes(date) ? current.filter((d) => d !== date) : [...current, date]));
  }

  const result = (
    <>
      <p className="order-plan-head">
        <strong>{plan.orders} {plan.orders === 1 ? "pedido" : "pedidos"}</strong>{branchName && <> · {branchName}</>}
        {daysText && <> · <span style={{ textTransform: "capitalize" }}>{daysText}</span></>}
      </p>
      <PlanTable title="Por kilo" lines={plan.byKg} />
      <PlanTable title="Por unidad" lines={plan.byUnit} />
      <p className="muted" style={{ fontSize: 13 }}>Esto es lo ya encargado. Sumale un margen por lo que se vende sin encargar.</p>
    </>
  );

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Qué tengo que preparar</h2>
        <div className="order-day-nav no-print">
          <label className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            Desde
            <input type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} />
          </label>
        </div>
      </div>

      <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>Tocá uno o varios días. Debajo de cada día, cuántos pedidos tiene.</p>
      <div className="order-day-strip no-print">
        {days.map((d) => {
          const n = counts[d] ?? 0;
          const date = new Date(`${d}T12:00:00`);
          return (
            <button
              key={d}
              type="button"
              className={`order-day-pick${selected.includes(d) ? " selected" : ""}${n >= 10 ? " heavy" : ""}`}
              onClick={() => toggle(d)}
            >
              <small>{date.toLocaleDateString("es-AR", { weekday: "short" })}</small>
              <strong>{d.slice(8, 10)}/{d.slice(5, 7)}</strong>
              <span>{n === 0 ? "—" : `${n} ${n === 1 ? "pedido" : "pedidos"}`}</span>
            </button>
          );
        })}
      </div>

      {error && <div className="message warning">{error}</div>}
      {loading ? (
        <p className="muted">Cargando…</p>
      ) : chosen.length === 0 ? (
        <p className="muted">Elegí al menos un día.</p>
      ) : plan.orders === 0 ? (
        <p className="muted">No hay pedidos pendientes para los días elegidos.</p>
      ) : (
        <>
          {result}
          <div className="form-actions no-print">
            <button className="secondary" onClick={() => setPrinting(true)}>Imprimir o guardar PDF</button>
          </div>
        </>
      )}

      {printing &&
        createPortal(
          <div className="print-area" style={{ padding: 16, background: "#fff" }}>
            <h2 style={{ margin: "0 0 4px" }}>Pedidos encargados</h2>
            {result}
          </div>,
          document.body
        )}
    </section>
  );
}
