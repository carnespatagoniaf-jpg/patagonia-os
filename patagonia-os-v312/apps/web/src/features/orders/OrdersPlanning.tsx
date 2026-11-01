import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addDaysIso, localDateIso } from "../shifts/format";
import { dayLabel, openCountByDate, planTotals, type CustomerOrder, type PlanLine } from "./orders-logic";
import { listOrders } from "./orders-service";

const MAX_DAYS = 62;

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

/** Planificación: qué hay que preparar (y comprar) en ESTE local entre dos fechas. Solo cantidades, nunca plata. */
export function OrdersPlanning({ branchId, branchName }: { branchId: string | null; branchName?: string }) {
  const [from, setFrom] = useState(() => localDateIso());
  const [to, setTo] = useState(() => localDateIso());
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [printing, setPrinting] = useState(false);
  const doneRef = useRef(() => setPrinting(false));

  // "Hasta" antes de "Desde" se toma como un solo día; como mucho 62 días.
  const days = useMemo(() => {
    const end = to < from ? from : to;
    const list: string[] = [];
    for (let d = from; d <= end && list.length < MAX_DAYS; d = addDaysIso(d, 1)) list.push(d);
    return list;
  }, [from, to]);

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
  const plan = planTotals(orders, days);
  const busyDays = days.filter((d) => (counts[d] ?? 0) > 0);
  const daysText = days.length === 1 ? dayLabel(days[0]) : `del ${dayLabel(days[0])} al ${dayLabel(days[days.length - 1])}`;

  const result = (
    <>
      <p className="order-plan-head">
        <strong>{plan.orders} {plan.orders === 1 ? "pedido" : "pedidos"}</strong>{branchName && <> · {branchName}</>}
        {daysText && <> · {daysText}</>}
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
            <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          </label>
          <label className="muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            Hasta
            <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
          </label>
        </div>
      </div>

      {!loading && busyDays.length > 0 && (
        <p className="muted no-print" style={{ margin: "0 0 12px", fontSize: 13 }}>
          Pedidos por día: {busyDays.map((d) => `${dayLabel(d)} (${counts[d]})`).join(" · ")}
        </p>
      )}

      {error && <div className="message warning">{error}</div>}
      {loading ? (
        <p className="muted">Cargando…</p>
      ) : plan.orders === 0 ? (
        <p className="muted">No hay pedidos pendientes para esas fechas.</p>
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
