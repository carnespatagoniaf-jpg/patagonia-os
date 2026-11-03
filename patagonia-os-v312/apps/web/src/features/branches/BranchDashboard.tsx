import { useEffect, useMemo, useState } from "react";
import type { Product } from "@patagonia/domain";
import { addDaysIso, endOfMonthIso, formatMoney, startOfMonthIso, startOfWeekIso, todayIso } from "../shifts/format";
import { getPeriodResult, getSalesActivity, listSalesByProduct } from "../sale/pos-shift-service";
import { computePeriodResult } from "../shifts/period-result";
import { listProductsForBranch } from "../inventory/inventory-service";
import type { ProductSalesRow } from "../shifts/sales-by-category";
import type { BranchOverview } from "./branches-overview-service";
import { branchAlerts, branchTotals, rankBranches, salesByWeekday, type BranchRow, type BranchStats } from "./branch-dashboard";
import { effectiveMin } from "../transfers/transfer-logic";
import { listBranchMinStock } from "../transfers/transfers-service";

type Preset = "hoy" | "ayer" | "semana" | "mes" | "mes_pasado";

function presetRange(p: Preset): { from: string; to: string } {
  const today = todayIso();
  switch (p) {
    case "hoy":
      return { from: today, to: today };
    case "ayer":
      return { from: addDaysIso(today, -1), to: addDaysIso(today, -1) };
    case "semana":
      return { from: startOfWeekIso(today), to: today };
    case "mes":
      return { from: startOfMonthIso(today), to: today };
    case "mes_pasado": {
      const last = addDaysIso(startOfMonthIso(today), -1);
      return { from: startOfMonthIso(last), to: endOfMonthIso(last) };
    }
  }
}

const PRESETS: [Preset, string][] = [
  ["hoy", "Hoy"],
  ["ayer", "Ayer"],
  ["semana", "Esta semana"],
  ["mes", "Este mes"],
  ["mes_pasado", "Mes pasado"]
];

const DOW = ["", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

function days(from: string, to: string) {
  return Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000) + 1;
}

function argHour() {
  return new Date(Date.now() - 3 * 3600_000).getUTCHours();
}

/** Debajo del mínimo: el del local (plan Empresa, migración 190) o, si no tiene, el general del producto. */
function isLowStock(p: Product, branchMins?: Map<string, number>) {
  const min = effectiveMin(p.minStock, branchMins?.get(p.id));
  return (p.active ?? true) && !p.stockSourceId && (p.stock < 0 || (min > 0 && p.stock <= min));
}

const fmtPct = (n: number | null) => (n === null ? "—" : `${String(n).replace(".", ",")}%`);

interface BranchExtra {
  topProducts: ProductSalesRow[];
  lowProducts: Product[];
}

/** Junta, local por local, lo que ya calculan Reportes y Rentabilidad. */
async function loadBranch(b: BranchOverview, from: string, to: string, branchMins?: Map<string, number>): Promise<{ stats: BranchStats; hours: { dow: number; total: number }[]; extra: BranchExtra }> {
  const n = days(from, to);
  const [result, prev, activity, sold, products] = await Promise.all([
    getPeriodResult(b.branchId, from, to).then(computePeriodResult).catch(() => null),
    getPeriodResult(b.branchId, addDaysIso(from, -n), addDaysIso(from, -1)).then(computePeriodResult).catch(() => null),
    getSalesActivity(b.branchId, from, to).catch(() => ({ cashiers: [], hours: [] })),
    listSalesByProduct(b.branchId, from, to).catch(() => [] as ProductSalesRow[]),
    listProductsForBranch(b.branchId).catch(() => [] as Product[])
  ]);
  const cashiers = activity.cashiers;
  const seesCash = cashiers.some((c) => c.cashDifference !== null);
  const shortCashier = cashiers
    .filter((c) => (c.shortShifts ?? 0) > 0)
    .sort((a, b) => (b.shortShifts ?? 0) - (a.shortShifts ?? 0))[0];
  // Faltantes: se suman los cajeros que dieron negativo (un cajero con sobrante no tapa el faltante de otro).
  const cashShort = cashiers.reduce((acc, c) => acc + Math.min(0, c.cashDifference ?? 0), 0);
  const lowProducts = products.filter((p) => isLowStock(p, branchMins));
  return {
    stats: {
      branchId: b.branchId,
      branchName: b.branchName,
      sales: result?.sales ?? 0,
      prevSales: prev ? prev.sales : null,
      grossProfit: result?.grossProfit ?? 0,
      result: result?.result ?? 0,
      posSales: cashiers.reduce((acc, c) => acc + c.sales, 0),
      posTotal: cashiers.reduce((acc, c) => acc + c.total, 0),
      kilos: sold.filter((r) => r.unit === "kg").reduce((acc, r) => acc + r.quantity, 0),
      cashDifference: seesCash ? cashiers.reduce((acc, c) => acc + (c.cashDifference ?? 0), 0) : null,
      cashShort,
      shortShifts: cashiers.reduce((acc, c) => acc + (c.shortShifts ?? 0), 0),
      shifts: cashiers.reduce((acc, c) => acc + (c.shifts ?? 0), 0),
      shortCashier: shortCashier ? { name: shortCashier.cashierName, shifts: shortCashier.shortShifts ?? 0 } : null,
      voidedCount: cashiers.reduce((acc, c) => acc + c.voidedCount, 0),
      voidedAmount: cashiers.reduce((acc, c) => acc + c.voidedAmount, 0),
      shiftOpen: b.shiftOpen,
      lowStock: lowProducts.length
    },
    hours: activity.hours,
    extra: { topProducts: [...sold].sort((a, b) => b.amount - a.amount).slice(0, 5), lowProducts: lowProducts.slice(0, 12) }
  };
}

export function BranchDashboard({ branches, onTab }: { branches: BranchOverview[]; onTab: (tab: "caja") => void }) {
  const [preset, setPreset] = useState<Preset>("semana");
  const { from, to } = presetRange(preset);
  const [stats, setStats] = useState<BranchStats[]>([]);
  const [hours, setHours] = useState<{ dow: number; total: number }[][]>([]);
  const [extra, setExtra] = useState<Record<string, BranchExtra>>({});
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const branchKey = branches.map((b) => `${b.branchId}:${b.shiftOpen}`).join(",");

  useEffect(() => {
    if (branches.length === 0) return;
    let cancelled = false;
    setLoading(true);
    // Mínimos por local (plan Empresa); sin el plan o sin la migración viene vacío.
    void listBranchMinStock()
      .catch(() => new Map<string, Map<string, number>>())
      .then((mins) => Promise.all(branches.map((b) => loadBranch(b, from, to, mins.get(b.branchId)))))
      .then((list) => {
        if (cancelled) return;
        setStats(list.map((l) => l.stats));
        setHours(list.map((l) => l.hours));
        setExtra(Object.fromEntries(list.map((l) => [l.stats.branchId, l.extra])));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchKey, from, to]);

  const rows = useMemo(() => rankBranches(stats), [stats]);
  const totals = useMemo(() => branchTotals(stats), [stats]);
  const alerts = useMemo(() => branchAlerts(rows, { includesToday: to === todayIso(), hour: argHour() }), [rows, to]);
  const weekdays = useMemo(() => salesByWeekday(hours), [hours]);
  const weekdayMax = Math.max(1, ...weekdays.map((d) => d.total));
  const selected: BranchRow | undefined = rows.find((r) => r.branchId === selectedId) ?? rows[rows.length - 1];
  const periodWord = preset === "hoy" || preset === "ayer" ? "el día" : preset === "semana" ? "la semana" : "el mes";

  return (
    <>
      <div className="ws-chips" style={{ marginBottom: 14 }}>
        {PRESETS.map(([key, label]) => (
          <button key={key} className={preset === key ? "ws-chip active" : "ws-chip"} onClick={() => setPreset(key)}>{label}</button>
        ))}
        {loading && <span className="muted" style={{ fontSize: 13 }}>Calculando los {branches.length} locales…</span>}
      </div>

      <div className="ws-cards bd-cards">
        <div className="ws-card total">
          <span>Vendieron entre todos</span>
          <strong>{formatMoney(totals.sales)}</strong>
          <small>{totals.change === null ? `${branches.length} locales` : `${totals.change >= 0 ? "↑" : "↓"} ${fmtPct(Math.abs(totals.change))} vs. período anterior`}</small>
        </div>
        <div className="ws-card">
          <span>Ganancia bruta</span>
          <strong>{formatMoney(totals.grossProfit)}</strong>
          <small>{fmtPct(totals.marginPct)} de lo vendido</small>
        </div>
        <div className="ws-card">
          <span>Te quedó (con gastos y sueldos)</span>
          <strong className={totals.result < 0 ? "num-negative" : "num-positive"}>{formatMoney(totals.result)}</strong>
          <small>sin los costos fijos</small>
        </div>
        <div className="ws-card">
          <span>Ticket promedio (Mostrador)</span>
          <strong>{formatMoney(totals.avgTicket)}</strong>
          <small>{totals.posSales} ventas</small>
        </div>
        <button className={`ws-card ws-card-button${totals.cashShort <= -1 ? " bad" : ""}`} onClick={() => onTab("caja")}>
          <span>Faltó en las cajas</span>
          <strong>{formatMoney(Math.abs(totals.cashShort))}</strong>
          <small>{totals.shortShifts} de {totals.shifts} cierres · ver</small>
        </button>
      </div>

      {alerts.length > 0 && (
        <div className="bd-alerts">
          {alerts.slice(0, 6).map((a, i) => (
            <button key={i} className={`bd-alert ${a.tone}`} onClick={() => setSelectedId(a.branchId)}>
              <span className="bd-alert-icon">{a.tone === "info" ? "i" : "!"}</span>
              <span><b>{a.title}</b>{a.detail}</span>
            </button>
          ))}
        </div>
      )}

      <section className="panel">
        <div className="panel-title" style={{ marginBottom: 8 }}>
          <h2>Ranking de {periodWord}</h2>
          <span className="muted" style={{ fontSize: 13 }}>Tocá un local para ver su detalle</span>
        </div>
        <div className="table-scroll">
          <table className="data-table bd-table">
            <thead>
              <tr>
                <th>Local</th>
                <th className="num">Vendió</th>
                <th className="num">vs. anterior</th>
                <th className="num">Margen</th>
                <th className="num hide-sm">Te quedó</th>
                <th className="num hide-md">Ventas</th>
                <th className="num hide-md">Ticket prom.</th>
                <th className="num hide-md">Kilos</th>
                <th className="num">Caja</th>
                <th className="num hide-sm">Anuladas</th>
                <th>Hoy</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.branchId} className={r.branchId === selected?.branchId ? "row-selected" : "row-clickable"} onClick={() => setSelectedId(r.branchId)}>
                  <td><span className={`bd-rank${r.rank <= 3 ? " top" : ""}`}>{r.rank}</span><b>{r.branchName}</b></td>
                  <td className="num"><span className="bd-bar"><i style={{ width: `${r.barPct}%` }} /></span><b>{formatMoney(r.sales)}</b></td>
                  <td className={`num ${r.change === null ? "muted" : r.change >= 0 ? "num-positive" : "num-negative"}`}>{r.change === null ? "—" : `${r.change >= 0 ? "↑" : "↓"} ${fmtPct(Math.abs(r.change))}`}</td>
                  <td className="num">{r.marginPct === null ? "—" : <span className={`margin-badge ${r.marginPct < (totals.marginPct ?? 0) - 5 ? "low" : "ok"}`}>{fmtPct(r.marginPct)}</span>}</td>
                  <td className={`num hide-sm ${r.result < 0 ? "num-negative" : ""}`}>{formatMoney(r.result)}</td>
                  <td className="num hide-md">{r.posSales}</td>
                  <td className="num hide-md">{formatMoney(r.avgTicket)}</td>
                  <td className="num hide-md">{new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(r.kilos)} kg</td>
                  <td className={`num ${r.cashDifference === null ? "muted" : r.cashDifference < -1 ? "num-negative" : r.cashDifference > 1 ? "num-positive" : "muted"}`}>
                    {r.cashDifference === null ? "—" : Math.abs(r.cashDifference) < 1 ? "$ 0" : `${r.cashDifference < 0 ? "−" : "+"} ${formatMoney(Math.abs(r.cashDifference))}`}
                  </td>
                  <td className="num hide-sm">{r.voidedCount}</td>
                  <td>{r.shiftOpen ? <span className="badge ok">Abierta</span> : <span className="badge">Cerrada</span>}</td>
                </tr>
              ))}
              {rows.length > 1 && (
                <tr className="bd-total">
                  <td>Todos</td>
                  <td className="num">{formatMoney(totals.sales)}</td>
                  <td className="num">{totals.change === null ? "—" : `${totals.change >= 0 ? "↑" : "↓"} ${fmtPct(Math.abs(totals.change))}`}</td>
                  <td className="num">{fmtPct(totals.marginPct)}</td>
                  <td className="num hide-sm">{formatMoney(totals.result)}</td>
                  <td className="num hide-md">{totals.posSales}</td>
                  <td className="num hide-md">{formatMoney(totals.avgTicket)}</td>
                  <td className="num hide-md">{new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(totals.kilos)} kg</td>
                  <td className="num">{totals.cashDifference === null ? "—" : `${totals.cashDifference < 0 ? "−" : "+"} ${formatMoney(Math.abs(totals.cashDifference))}`}</td>
                  <td className="num hide-sm">{totals.voidedCount}</td>
                  <td></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
          "Vendió" junta Mostrador, ventas a cuenta y Turnos. "Te quedó" = lo vendido menos la mercadería, los gastos, los sueldos y las mermas de cada local (igual que Reportes → Resultado, sin costos fijos). "Ventas", "Ticket" y "Kilos" son de Mostrador. "Caja" = faltantes y sobrantes de los cierres.
        </p>
      </section>

      <div className="ws-cols" style={{ marginTop: 16 }}>
        {selected && (
          <section className="panel">
            <div className="panel-title" style={{ marginBottom: 8 }}>
              <h2>{selected.branchName}</h2>
              <span className="muted" style={{ fontSize: 13 }}>{selected.rank}.º de {rows.length}</span>
            </div>
            <table className="data-table no-stack bd-detail">
              <tbody>
                <tr><td>Vendió</td><td className="num"><b>{formatMoney(selected.sales)}</b> {selected.change !== null && <span className={selected.change >= 0 ? "num-positive" : "num-negative"}>{selected.change >= 0 ? "↑" : "↓"} {fmtPct(Math.abs(selected.change))}</span>}</td></tr>
                <tr><td>Margen</td><td className="num">{fmtPct(selected.marginPct)} <span className="muted">(todos juntos, {fmtPct(totals.marginPct)})</span></td></tr>
                <tr><td>Te quedó</td><td className={`num ${selected.result < 0 ? "num-negative" : ""}`}>{formatMoney(selected.result)}</td></tr>
                <tr><td>Caja</td><td className="num">{selected.shortShifts > 0 ? <span className="num-negative">faltó {formatMoney(-selected.cashShort)} en {selected.shortShifts} de {selected.shifts} cierres{selected.shortCashier ? ` (${selected.shortCashier.name}: ${selected.shortCashier.shifts})` : ""}</span> : <span className="muted">{selected.shifts} cierres sin faltantes</span>}</td></tr>
                <tr><td>Anuladas</td><td className="num">{selected.voidedCount} {selected.voidedCount > 0 && <span className="muted">por {formatMoney(selected.voidedAmount)}</span>}</td></tr>
                <tr><td>Lo que más vendió</td><td className="num">{(extra[selected.branchId]?.topProducts ?? []).slice(0, 3).map((p) => `${p.productName} ${formatMoney(p.amount)}`).join(" · ") || "—"}</td></tr>
                <tr><td>Debajo del mínimo</td><td className="num">{selected.lowStock === 0 ? <span className="muted">nada</span> : (extra[selected.branchId]?.lowProducts ?? []).slice(0, 6).map((p) => p.name).join(", ") + (selected.lowStock > 6 ? ` y ${selected.lowStock - 6} más` : "")}</td></tr>
              </tbody>
            </table>
          </section>
        )}
        <section className="panel">
          <div className="panel-title" style={{ marginBottom: 8 }}>
            <h2>Qué día se vende más</h2>
            <span className="muted" style={{ fontSize: 13 }}>Mostrador, todos los locales</span>
          </div>
          <table className="data-table no-stack">
            <tbody>
              {weekdays.map((d) => (
                <tr key={d.dow}>
                  <td className="ws-date">{DOW[d.dow]}</td>
                  <td style={{ width: "55%" }}><div className="ws-bar"><i style={{ width: `${Math.round((d.total / weekdayMax) * 100)}%` }} /></div></td>
                  <td className="num">{formatMoney(d.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

/** Pestaña "Caja de cada local": los cierres del período, local por local. */
export function BranchCashTab({ branches }: { branches: BranchOverview[] }) {
  const [preset, setPreset] = useState<Preset>("semana");
  const { from, to } = presetRange(preset);
  const [stats, setStats] = useState<BranchStats[]>([]);
  const [loading, setLoading] = useState(false);
  const branchKey = branches.map((b) => b.branchId).join(",");
  useEffect(() => {
    if (branches.length === 0) return;
    let cancelled = false;
    setLoading(true);
    void Promise.all(branches.map((b) => loadBranch(b, from, to)))
      .then((list) => { if (!cancelled) setStats(list.map((l) => l.stats)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchKey, from, to]);
  const rows = [...stats].sort((a, b) => a.cashShort - b.cashShort);
  return (
    <>
      <div className="ws-chips" style={{ marginBottom: 14 }}>
        {PRESETS.map(([key, label]) => (
          <button key={key} className={preset === key ? "ws-chip active" : "ws-chip"} onClick={() => setPreset(key)}>{label}</button>
        ))}
        {loading && <span className="muted" style={{ fontSize: 13 }}>Calculando…</span>}
      </div>
      <section className="panel">
        <p className="muted acc-tab-help">Los cierres de caja de cada local en el período: cuántos tuvieron faltante, cuánto faltó, quién cerró con más faltantes y las ventas anuladas. Ordenado del que más faltó al que menos. El detalle de cada cierre está en Mostrador → Control de caja de ese local.</p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Local</th><th className="num">Cierres</th><th className="num">Con faltante</th><th className="num">Faltó</th><th className="num hide-sm">Diferencia neta</th><th className="hide-md">Quién cerró con más faltantes</th><th className="num">Anuladas</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.branchId}>
                  <td><b>{r.branchName}</b></td>
                  <td className="num">{r.shifts}</td>
                  <td className="num">{r.shortShifts > 0 ? <span className="badge danger">{r.shortShifts}</span> : <span className="muted">0</span>}</td>
                  <td className={`num ${r.cashShort <= -1 ? "num-negative" : "muted"}`}>{r.cashShort <= -1 ? formatMoney(-r.cashShort) : "$ 0"}</td>
                  <td className="num hide-sm">{r.cashDifference === null ? "—" : formatMoney(r.cashDifference)}</td>
                  <td className="hide-md">{r.shortCashier ? `${r.shortCashier.name} (${r.shortCashier.shifts})` : <span className="muted">—</span>}</td>
                  <td className="num">{r.voidedCount} {r.voidedCount > 0 && <span className="muted">· {formatMoney(r.voidedAmount)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
