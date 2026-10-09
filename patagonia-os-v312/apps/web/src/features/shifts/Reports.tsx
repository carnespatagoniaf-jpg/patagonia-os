import { Fragment, useMemo, useState } from "react";
import { useShifts } from "./useShifts";
import { useTreasury } from "./useTreasury";
import { addDaysIso, formatMoney, todayIso } from "./format";
import type { ShiftRangeRow } from "./shifts-service";
import { listPosSalesInRange, listSalesByProduct, type MostradorSaleEntry } from "../sale/pos-shift-service";
import { changePct, groupSalesByCategory, marginOnCost, previousPeriod, type ProductSalesRow } from "./sales-by-category";

const kgText = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })} kg`;
/** "↑ 18% vs. período anterior" en verde, "↓ 9%" en rojo. */
function ChangeBadge({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const up = pct >= 0;
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: up ? "#176329" : "#8b1e1e" }} title="Comparado con el período anterior del mismo largo">
      {up ? "↑" : "↓"} {Math.abs(pct).toLocaleString("es-AR", { maximumFractionDigits: 1 })}% vs. anterior
    </div>
  );
}

const pctText = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })}%`;

const unitsText = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 1 })} u.`;

export function Reports() {
  const { branchId, loadRange } = useShifts();
  const { accounts } = useTreasury();

  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [rows, setRows] = useState<ShiftRangeRow[]>([]);
  const [mostradorSales, setMostradorSales] = useState<MostradorSaleEntry[]>([]);
  const [productSales, setProductSales] = useState<ProductSalesRow[]>([]);
  const [previousSales, setPreviousSales] = useState<ProductSalesRow[]>([]);
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ranOnce, setRanOnce] = useState(false);

  async function runReport(nextFrom: string, nextTo: string) {
    setFrom(nextFrom);
    setTo(nextTo);
    setLoading(true);
    try {
      const prev = previousPeriod(nextFrom, nextTo);
      const [shiftRows, mostrador, byProduct, byProductBefore] = await Promise.all([
        loadRange(nextFrom, nextTo),
        branchId ? listPosSalesInRange(branchId, nextFrom, nextTo) : Promise.resolve([]),
        // Si la base todavía no tiene la migración 114, el resto del reporte sale igual.
        branchId ? listSalesByProduct(branchId, nextFrom, nextTo).catch(() => [] as ProductSalesRow[]) : Promise.resolve([] as ProductSalesRow[]),
        branchId ? listSalesByProduct(branchId, prev.from, prev.to).catch(() => [] as ProductSalesRow[]) : Promise.resolve([] as ProductSalesRow[])
      ]);
      setRows(shiftRows);
      setMostradorSales(mostrador);
      setProductSales(byProduct);
      setPreviousSales(byProductBefore);
      setOpenCategory(null);
      setRanOnce(true);
    } finally {
      setLoading(false);
    }
  }

  const turnosTotal = rows.reduce((sum, row) => sum + row.sales.reduce((s, r) => s + r.amount, 0), 0);
  const mostradorTotal = mostradorSales.reduce((sum, s) => sum + s.amount, 0);
  const salesTotal = turnosTotal + mostradorTotal;
  const outflowsTotal = rows.reduce((sum, row) => sum + row.outflows.reduce((s, r) => s + r.amount, 0), 0);

  const byCategory = useMemo(() => groupSalesByCategory(productSales), [productSales]);
  const before = useMemo(() => {
    const grouped = groupSalesByCategory(previousSales);
    const productAmount = new Map(previousSales.map((p) => [p.productId ?? p.productName, p.amount]));
    return { total: grouped.total, byCategory: new Map(grouped.categories.map((c) => [c.key, c.amount])), productAmount };
  }, [previousSales]);

  const salesByDate = [...rows].sort((a, b) => a.shift.shiftDate.localeCompare(b.shift.shiftDate));

  const byAccount = useMemo(
    () =>
      accounts.map((account) => {
        const turnos = rows.reduce(
          (sum, row) => sum + row.sales.filter((s) => s.accountId === account.id).reduce((s, r) => s + r.amount, 0),
          0
        );
        const mostrador = mostradorSales.filter((s) => s.accountId === account.id).reduce((sum, s) => sum + s.amount, 0);
        const outflows = rows.reduce(
          (sum, row) => sum + row.outflows.filter((o) => o.accountId === account.id).reduce((s, r) => s + r.amount, 0),
          0
        );
        const sales = turnos + mostrador;
        return { accountId: account.id, name: account.name, sales, outflows, difference: sales - outflows };
      }),
    [accounts, rows, mostradorSales]
  );

  const salesByDay = useMemo(() => {
    const dates = Array.from(
      new Set([...rows.map((row) => row.shift.shiftDate), ...mostradorSales.map((s) => s.date)])
    ).sort();
    return dates.map((date) => {
      const dayRows = rows.filter((row) => row.shift.shiftDate === date);
      const dayMostrador = mostradorSales.filter((s) => s.date === date);
      const perAccount = accounts.map((account) => ({
        accountId: account.id,
        amount:
          dayRows.reduce(
            (sum, row) => sum + row.sales.filter((s) => s.accountId === account.id).reduce((s, r) => s + r.amount, 0),
            0
          ) + dayMostrador.filter((s) => s.accountId === account.id).reduce((sum, s) => sum + s.amount, 0)
      }));
      const total = perAccount.reduce((sum, a) => sum + a.amount, 0);
      return { date, perAccount, total };
    });
  }, [rows, mostradorSales, accounts]);

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">REPORTES</p>
          <h1>Reportes</h1>
          <p className="muted">Ventas y salidas por rango de fechas: por categoría (carne, pollo…), por fecha y por cuenta.</p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-title">
          <h2>Ventas</h2>
        </div>
        <div className="cash-banner-form" style={{ flexWrap: "wrap", marginBottom: 14 }}>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <button onClick={() => runReport(from, to)}>Buscar</button>
          <button className="secondary" onClick={() => runReport(todayIso(), todayIso())}>Hoy</button>
          <button className="secondary" onClick={() => runReport(addDaysIso(todayIso(), -6), todayIso())}>Esta semana</button>
          <button className="secondary" onClick={() => runReport(addDaysIso(todayIso(), -29), todayIso())}>Este mes</button>
        </div>

        {loading ? (
          <p className="muted">Cargando…</p>
        ) : !ranOnce ? (
          <p className="muted">Elegí un rango para ver el reporte.</p>
        ) : (
          <div className="kpi-grid" style={{ marginBottom: 0 }}>
            <div className="kpi-card">
              <span>Ventas totales</span>
              <strong>{formatMoney(salesTotal)}</strong>
              <small>Turnos {formatMoney(turnosTotal)} · Mostrador {formatMoney(mostradorTotal)}</small>
            </div>
            <div className="kpi-card">
              <span>Turnos en el rango</span>
              <strong>{rows.length}</strong>
            </div>
            <div className="kpi-card">
              <span>Salidas totales</span>
              <strong>{formatMoney(outflowsTotal)}</strong>
            </div>
          </div>
        )}
      </section>

      {ranOnce && !loading && (
        <>
          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Por categoría</h2>
              <span className="muted" style={{ fontSize: 12 }}>Mostrador · tocá una categoría para ver sus productos</span>
            </div>
            {byCategory.categories.length === 0 ? (
              <p className="muted">No hay ventas de Mostrador en ese rango.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Categoría</th>
                    <th className="num">Vendido</th>
                    <th className="num">Kilos</th>
                    <th className="num">Ganancia</th>
                    <th className="num">% de lo vendido</th>
                  </tr>
                </thead>
                <tbody>
                  {byCategory.categories.map((cat) => (
                    <Fragment key={cat.key}>
                      <tr style={{ cursor: "pointer" }} onClick={() => setOpenCategory(openCategory === cat.key ? null : cat.key)}>
                        <td>
                          <strong>{openCategory === cat.key ? "▾" : "▸"} {cat.name}</strong>
                          {cat.unidentified && <div className="muted" style={{ fontSize: 12 }}>Tickets de total de la balanza o "Vender algo sin código": no se sabe qué producto era.</div>}
                        </td>
                        <td className="num">
                          {formatMoney(cat.amount)}
                          <ChangeBadge pct={changePct(cat.amount, before.byCategory.get(cat.key) ?? 0)} />
                        </td>
                        <td className="num">
                          {cat.kg > 0 ? kgText(cat.kg) : cat.unidentified ? "—" : ""}
                          {cat.units > 0 && <div className="muted" style={{ fontSize: 12 }}>+ {unitsText(cat.units)}</div>}
                        </td>
                        <td className="num">
                          {cat.profit === null ? "—" : formatMoney(cat.profit)}
                          {cat.marginPct !== null && <div className="muted" style={{ fontSize: 12 }}>margen {pctText(cat.marginPct)}</div>}
                        </td>
                        <td className="num">
                          {cat.pct.toLocaleString("es-AR", { maximumFractionDigits: 1 })}%
                          <div style={{ height: 4, background: "#eef0f3", borderRadius: 2, marginTop: 4 }}>
                            <div style={{ width: `${Math.min(cat.pct, 100)}%`, height: 4, borderRadius: 2, background: cat.unidentified ? "#c3cad5" : "#8b1e1e" }} />
                          </div>
                        </td>
                      </tr>
                      {openCategory === cat.key &&
                        cat.products.map((p) => (
                          <tr key={`${cat.key}-${p.productId ?? p.productName}`} style={{ background: "#fafafa" }}>
                            <td style={{ paddingLeft: 28 }}>{p.productCode ? `${p.productCode} · ` : ""}{p.productName}</td>
                            <td className="num">
                              {formatMoney(p.amount)}
                              <ChangeBadge pct={changePct(p.amount, before.productAmount.get(p.productId ?? p.productName) ?? 0)} />
                            </td>
                            <td className="num">{p.unit === "kg" ? kgText(p.quantity) : p.unit ? unitsText(p.quantity) : `${p.lines} ${p.lines === 1 ? "línea" : "líneas"}`}</td>
                            <td className="num">
                              {p.productId === null ? "—" : formatMoney(p.amount - p.cost)}
                              {p.productId !== null && marginOnCost(p.amount, p.cost) !== null && (
                                <div className="muted" style={{ fontSize: 12 }}>margen {pctText(marginOnCost(p.amount, p.cost)!)}</div>
                              )}
                              {p.missingCostLines > 0 && <div style={{ fontSize: 12, color: "#8a4b00" }}>sin costo cargado</div>}
                            </td>
                            <td className="num muted">{byCategory.total > 0 ? `${((p.amount / byCategory.total) * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })}%` : ""}</td>
                          </tr>
                        ))}
                    </Fragment>
                  ))}
                  <tr>
                    <td><strong>Total</strong></td>
                    <td className="num">
                      <strong>{formatMoney(byCategory.total)}</strong>
                      <ChangeBadge pct={changePct(byCategory.total, before.total)} />
                    </td>
                    <td className="num"><strong>{kgText(byCategory.categories.reduce((sum, c) => sum + c.kg, 0))}</strong></td>
                    <td className="num"><strong>{formatMoney(byCategory.profit)}</strong></td>
                    <td className="num">100%</td>
                  </tr>
                </tbody>
              </table>
            )}
            <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
              Importe de cada renglón; los descuentos o recargos generales de la venta no se reparten por producto. "vs. anterior" compara con el período anterior del mismo largo.
              Ganancia = vendido − costo; el margen es sobre el costo, como en Stock.
            </p>
            {byCategory.estimatedCostLines > 0 && (
              <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                Las ventas anteriores al 8/10/2026 no guardaban su costo: para esas, la ganancia usa el costo de hoy (es estimada).
              </p>
            )}
            {byCategory.missingCostProducts.length > 0 && (
              <p style={{ fontSize: 12, margin: "4px 0 0", color: "#8a4b00" }}>
                {byCategory.missingCostProducts.length === 1 ? "1 producto vendido no tiene" : `${byCategory.missingCostProducts.length} productos vendidos no tienen`} costo cargado (su ganancia sale de más):{" "}
                {byCategory.missingCostProducts.slice(0, 6).join(", ")}{byCategory.missingCostProducts.length > 6 ? "…" : ""}. Cargalo en Stock.
              </p>
            )}
          </section>

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Por fecha</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  {accounts.map((account) => (
                    <th key={account.id} className="num">{account.name}</th>
                  ))}
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {salesByDay.map((day) => (
                  <tr key={day.date}>
                    <td>{day.date}</td>
                    {day.perAccount.map((a) => (
                      <td key={a.accountId} className="num">{formatMoney(a.amount)}</td>
                    ))}
                    <td className="num">{formatMoney(day.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {salesByDay.length === 0 && <p className="muted">No hay ventas cargadas en ese rango.</p>}
          </section>

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Por cuenta</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cuenta</th>
                  <th className="num">Ventas</th>
                  <th className="num">Salidas</th>
                  <th className="num">Diferencia</th>
                </tr>
              </thead>
              <tbody>
                {byAccount.map((row) => (
                  <tr key={row.accountId}>
                    <td>{row.name}</td>
                    <td className="num">{formatMoney(row.sales)}</td>
                    <td className="num">{formatMoney(row.outflows)}</td>
                    <td className={`num ${row.difference < 0 ? "num-negative" : "num-positive"}`}>{formatMoney(row.difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {rows.length > 0 && (
          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Por turno</h2>
              <span className="muted" style={{ fontSize: 12 }}>Solo Turnos — Mostrador no se carga por turno mañana/tarde</span>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Turno</th>
                  <th className="num">Ventas</th>
                  <th className="num">Salidas</th>
                </tr>
              </thead>
              <tbody>
                {salesByDate.map((row) => (
                  <tr key={row.shift.id}>
                    <td>{row.shift.shiftDate}</td>
                    <td>{row.shift.shift === "morning" ? "Mañana" : "Tarde"}</td>
                    <td className="num">{formatMoney(row.sales.reduce((s, r) => s + r.amount, 0))}</td>
                    <td className="num">{formatMoney(row.outflows.reduce((s, r) => s + r.amount, 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          )}
        </>
      )}
    </>
  );
}
