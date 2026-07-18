import { useMemo, useState } from "react";
import { useShifts } from "./useShifts";
import { useTreasury } from "./useTreasury";
import { addDaysIso, formatMoney, todayIso } from "./format";
import type { ShiftRangeRow } from "./shifts-service";

export function Reports() {
  const { loadRange } = useShifts();
  const { accounts } = useTreasury();

  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [rows, setRows] = useState<ShiftRangeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [ranOnce, setRanOnce] = useState(false);

  async function runReport(nextFrom: string, nextTo: string) {
    setFrom(nextFrom);
    setTo(nextTo);
    setLoading(true);
    try {
      setRows(await loadRange(nextFrom, nextTo));
      setRanOnce(true);
    } finally {
      setLoading(false);
    }
  }

  const salesTotal = rows.reduce((sum, row) => sum + row.sales.reduce((s, r) => s + r.amount, 0), 0);
  const outflowsTotal = rows.reduce((sum, row) => sum + row.outflows.reduce((s, r) => s + r.amount, 0), 0);

  const salesByDate = [...rows].sort((a, b) => a.shift.shiftDate.localeCompare(b.shift.shiftDate));

  const byAccount = useMemo(
    () =>
      accounts.map((account) => {
        const sales = rows.reduce(
          (sum, row) => sum + row.sales.filter((s) => s.accountId === account.id).reduce((s, r) => s + r.amount, 0),
          0
        );
        const outflows = rows.reduce(
          (sum, row) => sum + row.outflows.filter((o) => o.accountId === account.id).reduce((s, r) => s + r.amount, 0),
          0
        );
        return { accountId: account.id, name: account.name, sales, outflows, difference: sales - outflows };
      }),
    [accounts, rows]
  );

  const salesByDay = useMemo(() => {
    const dates = Array.from(new Set(rows.map((row) => row.shift.shiftDate))).sort();
    return dates.map((date) => {
      const dayRows = rows.filter((row) => row.shift.shiftDate === date);
      const perAccount = accounts.map((account) => ({
        accountId: account.id,
        amount: dayRows.reduce(
          (sum, row) => sum + row.sales.filter((s) => s.accountId === account.id).reduce((s, r) => s + r.amount, 0),
          0
        )
      }));
      const total = perAccount.reduce((sum, a) => sum + a.amount, 0);
      return { date, perAccount, total };
    });
  }, [rows, accounts]);

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">REPORTES</p>
          <h1>Reportes</h1>
          <p className="muted">Ventas y salidas por rango de fechas. Con el tiempo se suman más reportes acá.</p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-title">
          <h2>Ventas por turno</h2>
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
              <span>Turnos en el rango</span>
              <strong>{rows.length}</strong>
            </div>
            <div className="kpi-card">
              <span>Ventas totales</span>
              <strong>{formatMoney(salesTotal)}</strong>
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

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-title">
              <h2>Por turno</h2>
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
            {rows.length === 0 && <p className="muted">No hay turnos cargados en ese rango.</p>}
          </section>
        </>
      )}
    </>
  );
}
