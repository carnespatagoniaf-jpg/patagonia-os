import { useEffect, useMemo, useState } from "react";
import { formatMoney } from "./format";
import type { ProductSalesRow } from "./sales-by-category";
import { getSalesActivity } from "../sale/pos-shift-service";
import { listProductsForBranch } from "../inventory/inventory-service";
import {
  DAY_NAMES,
  averageTicket,
  buildHourGrid,
  idleProducts,
  rankProducts,
  type CashierActivity,
  type HourActivity,
  type RankingOrder,
  type StockedProduct
} from "./sales-activity";

const kgText = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })} kg`;
const unitsText = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })} u.`;
const qtyText = (unit: string | null, n: number) => (unit === "kg" ? kgText(n) : unitsText(n));
const pctText = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })}%`;

/** Diferencia de caja; menos de $1 es redondeo de centavos y se muestra como "justo". */
const cashDiff = (c: CashierActivity) => c.cashDifference ?? 0;

const ORDER_LABELS: Record<RankingOrder, string> = { amount: "Más vendidos ($)", profit: "Más ganancia", quantity: "Más kilos" };

/**
 * Reportes, todos los planes (2026-10-22; migración 146): ranking de productos, por cajero y por día y hora.
 * Usa las ventas por producto que Reports.tsx ya trajo; cajeros/horarios y el stock
 * se piden acá cada vez que cambia la búsqueda (runId).
 */
export function ReportsActivity({ branchId, from, to, runId, productSales }: {
  branchId: string | null;
  from: string;
  to: string;
  runId: number;
  productSales: ProductSalesRow[];
}) {
  const [order, setOrder] = useState<RankingOrder>("amount");
  const [showAll, setShowAll] = useState(false);
  const [cashiers, setCashiers] = useState<CashierActivity[]>([]);
  const [hours, setHours] = useState<HourActivity[]>([]);
  // null = no se pudo leer el stock: no se muestra "Con stock y sin ventas".
  const [products, setProducts] = useState<StockedProduct[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!branchId || runId === 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setShowAll(false);
    Promise.all([
      getSalesActivity(branchId, from, to).catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "No se pudo cargar cajeros y horarios.");
        return { cashiers: [], hours: [] };
      }),
      listProductsForBranch(branchId).catch(() => null)
    ]).then(([activity, list]) => {
      if (cancelled) return;
      setCashiers(activity.cashiers);
      setHours(activity.hours);
      setProducts(list && list.map((p) => ({ id: p.id, code: p.code, name: p.name, unit: p.unit, stock: p.stock, cost: p.cost, stockSourceId: p.stockSourceId })));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // Solo al apretar Buscar/Hoy/Semana/Mes (runId), no al tocar las fechas.
  }, [runId, branchId]);

  const ranked = useMemo(() => rankProducts(productSales, order), [productSales, order]);
  const byAmount = useMemo(() => rankProducts(productSales, "amount"), [productSales]);
  const leastSold = byAmount.length > 10 ? byAmount.slice(-5).reverse() : [];
  const idle = useMemo(() => (products ? idleProducts(products, productSales) : []), [products, productSales]);
  const idleValue = idle.reduce((sum, p) => sum + p.value, 0);
  const grid = useMemo(() => buildHourGrid(hours), [hours]);
  const shown = showAll ? ranked : ranked.slice(0, 10);
  const seesCash = cashiers.some((c) => c.shifts !== null);

  return (
    <>
      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Ranking de productos</h2>
          <span className="muted" style={{ fontSize: 12 }}>Mostrador</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {(Object.keys(ORDER_LABELS) as RankingOrder[]).map((key) => (
            <button key={key} className={order === key ? undefined : "secondary"} onClick={() => setOrder(key)}>
              {ORDER_LABELS[key]}
            </button>
          ))}
        </div>
        {ranked.length === 0 ? (
          <p className="muted">No hay ventas de productos en ese rango.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Producto</th>
                  <th className="num">Vendido</th>
                  <th className="num">Cantidad</th>
                  <th className="num">Ganancia</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p, i) => (
                  <tr key={p.productId}>
                    <td className="muted">{i + 1}</td>
                    <td>{p.productCode ? `${p.productCode} · ` : ""}{p.productName}</td>
                    <td className="num">{formatMoney(p.amount)}</td>
                    <td className="num">{qtyText(p.unit, p.quantity)}</td>
                    <td className="num">
                      {formatMoney(p.profit)}
                      {p.marginPct !== null && <div className="muted" style={{ fontSize: 12 }}>margen {pctText(p.marginPct)}</div>}
                      {p.missingCostLines > 0 && <div style={{ fontSize: 12, color: "#8a4b00" }}>sin costo cargado</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {ranked.length > 10 && (
          <button className="secondary" style={{ marginTop: 10 }} onClick={() => setShowAll(!showAll)}>
            {showAll ? "Ver solo los 10 primeros" : `Ver los ${ranked.length}`}
          </button>
        )}

        {leastSold.length > 0 && (
          <>
            <h3 style={{ marginTop: 18, fontSize: 15 }}>Lo que menos se vendió</h3>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
              {leastSold.map((p) => `${p.productName} (${formatMoney(p.amount)})`).join(" · ")}
            </p>
          </>
        )}

        {products !== null && <h3 style={{ marginTop: 18, fontSize: 15 }}>Con stock y sin ventas</h3>}
        {products === null ? null : loading ? (
          <p className="muted">Cargando…</p>
        ) : idle.length === 0 ? (
          <p className="muted">Todo lo que tiene stock se vendió al menos una vez en este rango.</p>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
              {idle.length === 1 ? "1 producto tiene" : `${idle.length} productos tienen`} stock y no se vendieron: {formatMoney(idleValue)} parados (a costo).
            </p>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th className="num">Stock</th>
                    <th className="num">Plata parada</th>
                  </tr>
                </thead>
                <tbody>
                  {idle.slice(0, 10).map((p) => (
                    <tr key={p.id}>
                      <td>{p.code ? `${p.code} · ` : ""}{p.name}</td>
                      <td className="num">{qtyText(p.unit, p.stock)}</td>
                      <td className="num">{p.value > 0 ? formatMoney(p.value) : "sin costo"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {idle.length > 10 && <p className="muted" style={{ fontSize: 12 }}>Y {idle.length - 10} más.</p>}
          </>
        )}
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Por cajero</h2>
          <span className="muted" style={{ fontSize: 12 }}>Mostrador · quién cobró cada venta</span>
        </div>
        {loading ? (
          <p className="muted">Cargando…</p>
        ) : error ? (
          <p style={{ color: "#8b1e1e" }}>{error}</p>
        ) : cashiers.length === 0 ? (
          <p className="muted">No hay ventas de Mostrador en ese rango.</p>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Cajero</th>
                    <th className="num">Vendido</th>
                    <th className="num">Ventas</th>
                    <th className="num">Ticket promedio</th>
                    <th className="num">Anuladas</th>
                    <th className="num">Descuentos</th>
                    {seesCash && <th className="num">Cierres de caja</th>}
                  </tr>
                </thead>
                <tbody>
                  {cashiers.map((c) => (
                    <tr key={c.cashierName}>
                      <td>
                        <strong>{c.cashierName}</strong>
                        {!c.withPin && <div className="muted" style={{ fontSize: 12 }}>usuario (sin PIN de caja)</div>}
                      </td>
                      <td className="num">{formatMoney(c.total)}</td>
                      <td className="num">{c.sales}</td>
                      <td className="num">{formatMoney(averageTicket(c.total, c.sales))}</td>
                      <td className="num">
                        {c.voidedCount}
                        {c.voidedCount > 0 && <div className="muted" style={{ fontSize: 12 }}>{formatMoney(c.voidedAmount)}</div>}
                      </td>
                      <td className="num">{c.discount > 0 ? formatMoney(c.discount) : "—"}</td>
                      {seesCash && (
                        <td className="num">
                          {c.shifts ? (
                            <>
                              {c.shifts} {c.shifts === 1 ? "cierre" : "cierres"}
                              {(c.countedShifts ?? 0) > 0 && (
                                <div style={{ fontSize: 12, fontWeight: 700, color: cashDiff(c) <= -1 ? "#8b1e1e" : "#176329" }}>
                                  {cashDiff(c) <= -1 ? `faltó ${formatMoney(-cashDiff(c))}` : cashDiff(c) >= 1 ? `sobró ${formatMoney(cashDiff(c))}` : "justo"}
                                </div>
                              )}
                              {(c.shortShifts ?? 0) > 0 && (
                                <div className="muted" style={{ fontSize: 12 }}>
                                  {c.shortShifts} con faltante
                                </div>
                              )}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              El cajero es el que puso su PIN al abrir la caja; si la sucursal no usa PIN, es el usuario que cargó la venta.
              {seesCash && " Cierres de caja: efectivo contado menos el que tendría que haber, sumando los cierres del período."}
            </p>
          </>
        )}
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Por día y hora</h2>
          <span className="muted" style={{ fontSize: 12 }}>Mostrador · cuánto se vende en cada momento</span>
        </div>
        {loading ? (
          <p className="muted">Cargando…</p>
        ) : error ? (
          <p style={{ color: "#8b1e1e" }}>{error}</p>
        ) : grid.hours.length === 0 ? (
          <p className="muted">No hay ventas de Mostrador en ese rango.</p>
        ) : (
          <>
            <div className="kpi-grid" style={{ marginBottom: 14 }}>
              {grid.bestDay !== null && (
                <div className="kpi-card">
                  <span>El día que más se vende</span>
                  <strong>{DAY_NAMES[grid.bestDay - 1]}</strong>
                  <small>{formatMoney(grid.byDay[grid.bestDay - 1].total)} en el período</small>
                </div>
              )}
              {grid.bestHour !== null && (
                <div className="kpi-card">
                  <span>La hora que más se vende</span>
                  <strong>{grid.bestHour} a {grid.bestHour + 1} h</strong>
                  <small>{formatMoney(grid.byHour.find((h) => h.hour === grid.bestHour)?.total ?? 0)} en el período</small>
                </div>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Día</th>
                    {grid.hours.map((h) => (
                      <th key={h} className="num" style={{ padding: "8px 4px" }}>{h} h</th>
                    ))}
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {grid.byDay.filter((d) => d.sales > 0).map((d) => (
                    <tr key={d.dow}>
                      <td><strong>{DAY_NAMES[d.dow - 1]}</strong></td>
                      {grid.cells[d.dow - 1].map((value, i) => (
                        <td
                          key={grid.hours[i]}
                          className="num"
                          title={`${DAY_NAMES[d.dow - 1]} ${grid.hours[i]} h: ${formatMoney(value)}`}
                          style={{
                            padding: "8px 4px",
                            background: value > 0 ? `rgba(139, 30, 30, ${(0.08 + 0.72 * (value / grid.max)).toFixed(2)})` : undefined,
                            color: value / grid.max > 0.55 ? "#fff" : undefined
                          }}
                        >
                          {value > 0 ? `${Math.round(value / 1000).toLocaleString("es-AR")}k` : ""}
                        </td>
                      ))}
                      <td className="num">{formatMoney(d.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              Cada casilla es lo vendido ese día de la semana a esa hora, sumando todas las semanas del período (en miles de pesos). Más oscuro = más venta.
            </p>
          </>
        )}
      </section>
    </>
  );
}
