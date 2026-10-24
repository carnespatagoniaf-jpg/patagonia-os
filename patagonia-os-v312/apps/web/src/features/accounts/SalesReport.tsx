import { useCallback, useEffect, useMemo, useState } from "react";
import { listChargeItemsForCharges } from "../customers/customers-service";
import { formatMoney, localDateIso } from "../shifts/format";
import { listSalesInRange } from "./accounts-service";
import { PERIOD_LABELS, periodRange, shortDay, summarizeSales, type PeriodPreset, type ReportItem, type ReportSale } from "./sales-report";

const PRESETS: PeriodPreset[] = ["semana_pasada", "esta_semana", "ultimos_7", "este_mes", "mes_pasado"];

function formatQty(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(".", ",");
}

const dmy = (iso: string) => iso.split("-").reverse().join("/");

/** Ventas → "Reporte de ventas" (a pedido de Martínez, feature 'reporte_ventas'):
 * todas las ventas a cuenta de un período, con su detalle, totales por cliente y
 * "Guardar PDF" (imprimir → Guardar como PDF). */
export function SalesReport() {
  const [preset, setPreset] = useState<PeriodPreset | null>("semana_pasada");
  const [range, setRange] = useState(() => periodRange("semana_pasada", localDateIso()));
  const [sales, setSales] = useState<ReportSale[]>([]);
  const [items, setItems] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await listSalesInRange(range.from, range.to);
      setSales(list);
      setItems(await listChargeItemsForCharges(list.map((s) => s.id)));
    } catch {
      setError("No se pudieron cargar las ventas. Probá de nuevo.");
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => summarizeSales(sales, items), [sales, items]);

  function choose(p: PeriodPreset) {
    setPreset(p);
    setRange(periodRange(p, localDateIso()));
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">VENTAS</p>
          <h1>Reporte de ventas</h1>
          <p className="muted">Todas las ventas de un período, con el detalle de cada una. Para guardarlo en PDF: "Guardar PDF" y elegí "Guardar como PDF".</p>
        </div>
      </header>

      <section className="panel no-print">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {PRESETS.map((p) => (
            <button key={p} className={preset === p ? "" : "secondary"} onClick={() => choose(p)}>{PERIOD_LABELS[p]}</button>
          ))}
        </div>
        <div className="cash-banner-form" style={{ flexWrap: "wrap" }}>
          <label className="muted" style={{ display: "grid", gap: 2 }}>
            Desde
            <input type="date" value={range.from} onChange={(e) => { setPreset(null); setRange({ ...range, from: e.target.value }); }} />
          </label>
          <label className="muted" style={{ display: "grid", gap: 2 }}>
            Hasta
            <input type="date" value={range.to} onChange={(e) => { setPreset(null); setRange({ ...range, to: e.target.value }); }} />
          </label>
          <button disabled={loading || summary.count === 0} onClick={() => window.print()}>Guardar PDF</button>
        </div>
      </section>

      {error && <div className="message warning">{error}</div>}

      <div className="print-area">
        <div className="print-only-header">
          <strong>Reporte de ventas</strong> · del {dmy(range.from)} al {dmy(range.to)}
        </div>

        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Resumen del {dmy(range.from)} al {dmy(range.to)}</h2>
            <span>{loading ? "Cargando…" : `${summary.count} ventas`}</span>
          </div>
          <div className="totals">
            <span>Ventas <b>{summary.count}</b></span>
            {summary.kg > 0 && <span>Kilos vendidos <b>{formatQty(summary.kg)} kg</b></span>}
            <strong>Total vendido <b>{formatMoney(summary.total)}</b></strong>
          </div>
        </section>

        {summary.byCustomer.length > 0 && (
          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Por cliente</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th className="num">Ventas</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {summary.byCustomer.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td className="num">{c.count}</td>
                    <td className="num">{formatMoney(c.total)}</td>
                  </tr>
                ))}
                <tr>
                  <td><strong>Total</strong></td>
                  <td className="num"><strong>{summary.count}</strong></td>
                  <td className="num"><strong>{formatMoney(summary.total)}</strong></td>
                </tr>
              </tbody>
            </table>
          </section>
        )}

        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Detalle de las ventas</h2>
          </div>
          {!loading && summary.count === 0 && <p className="muted">No hay ventas en esas fechas.</p>}
          {summary.byDay.map((day) => (
            <div key={day.date} style={{ marginBottom: 14 }}>
              <div className="list-row" style={{ borderBottom: "2px solid #ddd" }}>
                <strong>{shortDay(day.date)}</strong>
                <strong>{formatMoney(day.total)}</strong>
              </div>
              <table className="data-table">
                <tbody>
                  {day.sales.map((s) => (
                    <tr key={s.id}>
                      <td style={{ width: "28%" }}>
                        <strong>{s.customerName}</strong>
                        {s.reason && <div className="muted" style={{ fontSize: 12 }}>{s.reason}</div>}
                      </td>
                      <td>
                        {s.items.length === 0 ? (
                          <span className="muted">Sin detalle</span>
                        ) : (
                          s.items.map((it, i) => (
                            <div key={i} style={{ fontSize: 13 }}>
                              {it.name}: {formatQty(it.quantity)} {it.unit === "kg" ? "kg" : it.unit === "unit" ? "u." : it.unit ?? ""} × {formatMoney(it.unitPrice)} = {formatMoney(it.lineTotal)}
                            </div>
                          ))
                        )}
                        {s.adjustment !== 0 && (
                          <div style={{ fontSize: 13 }}>{s.adjustment < 0 ? "Descuento" : "Recargo"}: {formatMoney(Math.abs(s.adjustment))}</div>
                        )}
                      </td>
                      <td className="num" style={{ width: "18%" }}><strong>{formatMoney(s.amount)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
