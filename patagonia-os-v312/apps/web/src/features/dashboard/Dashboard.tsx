import { useEffect, useState } from "react";
import type { Product } from "@patagonia/domain";
import { AlertTriangle, Boxes, CircleDollarSign, ReceiptText, TrendingUp } from "lucide-react";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { useActiveBranch } from "../branches/BranchProvider";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listProfitabilityPeriods } from "../profitability/profitability-service";
import { listPosSalesInRange } from "../sale/pos-shift-service";
import { addDaysIso, formatMoney, todayIso } from "../shifts/format";
import { useShifts } from "../shifts/useShifts";
import { useTreasury } from "../shifts/useTreasury";

interface DaySales {
  date: string;
  total: number;
}

export function Dashboard() {
  const { profile } = useAuth();
  const { branchId } = useActiveBranch();
  const { balances } = useTreasury();
  const { loadRange } = useShifts();

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [salesToday, setSalesToday] = useState(0);
  const [salesSeries, setSalesSeries] = useState<DaySales[]>([]);
  const [grossProfit, setGrossProfit] = useState<number | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!isSupabaseConfigured || !branchId) return;

    let cancelled = false;
    setLoading(true);
    const today = todayIso();
    const weekAgo = addDaysIso(today, -6);

    Promise.all([
      listProductsForBranch(branchId),
      loadRange(weekAgo, today),
      listProfitabilityPeriods(branchId),
      listPosSalesInRange(branchId, weekAgo, today)
    ])
      .then(([productList, shiftRows, periods, mostradorSales]) => {
        if (cancelled) return;
        setProducts(productList);

        const turnosByDate = new Map<string, number>();
        for (const row of shiftRows) {
          const dayTotal = row.sales.reduce((sum, sale) => sum + sale.amount, 0);
          turnosByDate.set(row.shift.shiftDate, (turnosByDate.get(row.shift.shiftDate) ?? 0) + dayTotal);
        }
        const mostradorByDate = new Map<string, number>();
        for (const sale of mostradorSales) {
          mostradorByDate.set(sale.date, (mostradorByDate.get(sale.date) ?? 0) + sale.amount);
        }

        const series: DaySales[] = [];
        for (let i = 6; i >= 0; i--) {
          const date = addDaysIso(today, -i);
          series.push({ date, total: (turnosByDate.get(date) ?? 0) + (mostradorByDate.get(date) ?? 0) });
        }
        setSalesSeries(series);
        setSalesToday(series[series.length - 1]?.total ?? 0);
        setGrossProfit(periods[0]?.grossProfit ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [branchId, loadRange]);

  const cashOnHand = balances.reduce((sum, balance) => sum + balance.balance, 0);
  const stockValue = products.reduce((sum, p) => sum + p.stock * p.cost, 0);
  const alerts = products.filter((p) => p.stock <= p.minStock);
  const firstName = profile?.full_name?.split(" ")[0] ?? "Usuario";

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">RESUMEN DE OPERACIÓN</p>
          <h1>Buenos días, {firstName}</h1>
          <p className="muted">
            {isSupabaseConfigured ? (loading ? "Cargando datos…" : "Datos en vivo de tu empresa.") : "Datos de demostración hasta conectar Supabase."}
          </p>
        </div>
        <span className="status-pill">V3.1 · {isSupabaseConfigured ? "En vivo" : "Desarrollo"}</span>
      </header>

      <section className="kpi-grid">
        <Kpi title="Ventas hoy" value={formatMoney(salesToday)} detail={`${salesToday === 0 ? "Sin" : ""} tickets de hoy`} icon={<CircleDollarSign />} />
        <Kpi
          title="Ganancia estimada"
          value={grossProfit !== null ? formatMoney(grossProfit) : "—"}
          detail={grossProfit !== null ? "Último período cerrado" : "Cerrá un período en Rentabilidad"}
          icon={<TrendingUp />}
        />
        <Kpi title="Caja actual" value={formatMoney(cashOnHand)} detail={`${balances.length} cuentas`} icon={<ReceiptText />} />
        <Kpi title="Stock valorizado" value={formatMoney(stockValue)} detail={`${alerts.length} alertas`} icon={<Boxes />} />
      </section>

      <section className="content-grid">
        <div className="panel">
          <div className="panel-title">
            <h2>Ventas</h2>
            <span className="muted">Últimos 7 días · Turnos + Mostrador</span>
          </div>
          {salesSeries.some((d) => d.total > 0) ? (
            <SalesTrendChart series={salesSeries} />
          ) : (
            <div className="empty-chart">
              <TrendingUp size={42} />
              <strong>Sin ventas en los últimos 7 días</strong>
              <span>{isSupabaseConfigured ? "Cargá ventas desde Turnos o Mostrador" : "Supabase pendiente de conexión"}</span>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">
            <h2>Alertas</h2>
            <AlertTriangle size={20} />
          </div>
          {alerts.length === 0 ? (
            <p className="muted">Sin alertas.</p>
          ) : (
            alerts.map((product) => (
              <div className="alert-row" key={product.id}>
                <AlertTriangle size={18} />
                <div>
                  <strong>{product.name}</strong>
                  <span>Stock: {product.stock} {product.unit}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}

function Kpi({ title, value, detail, icon }: { title: string; value: string; detail: string; icon: React.ReactNode }) {
  return (
    <article className="kpi-card">
      <div className="kpi-icon">{icon}</div>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function dayLabel(dateIso: string) {
  return new Date(`${dateIso}T00:00:00Z`).toLocaleDateString("es-AR", { weekday: "short", day: "numeric", timeZone: "UTC" });
}

function fullDateLabel(dateIso: string) {
  const label = new Date(`${dateIso}T00:00:00Z`).toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Barras de los últimos 7 días (Turnos + Mostrador combinados, ver
 * pos-shift-service.listPosSalesInRange). Un solo color/serie -- no hace
 * falta leyenda, el título del panel ya dice qué se está mostrando. */
function SalesTrendChart({ series }: { series: DaySales[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 560;
  const height = 200;
  const padding = { top: 34, right: 20, bottom: 26, left: 20 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const max = Math.max(...series.map((d) => d.total), 1);
  const barWidth = Math.min(24, chartW / series.length - 10);
  const slot = series.length > 1 ? chartW / (series.length - 1) : 0;
  const baselineY = height - padding.bottom;
  const maxIdx = series.reduce((best, d, i) => (d.total > series[best].total ? i : best), 0);

  const bars = series.map((d, i) => {
    const x = series.length > 1 ? padding.left + i * slot : width / 2;
    const barH = Math.max((d.total / max) * chartH, d.total > 0 ? 3 : 0);
    return { ...d, x, y: baselineY - barH, h: barH };
  });
  const hovered = hoverIdx !== null ? bars[hoverIdx] : null;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Ventas de los últimos 7 días">
        <line x1={padding.left} y1={baselineY} x2={width - padding.right} y2={baselineY} stroke="#e5e7eb" strokeWidth={1} />
        {bars.map((bar, i) => (
          <g key={bar.date}>
            <rect
              x={bar.x - barWidth / 2}
              y={bar.y}
              width={barWidth}
              height={bar.h}
              rx={4}
              fill={hoverIdx === i ? "#a8332f" : "#8b1e1e"}
              style={{ cursor: "pointer", transition: "fill .1s" }}
              tabIndex={0}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              onFocus={() => setHoverIdx(i)}
              onBlur={() => setHoverIdx(null)}
            />
            {i === maxIdx && bar.total > 0 && (
              <text x={bar.x} y={bar.y - 8} textAnchor="middle" fontSize={11} fontWeight={800} fill="#47505c">
                {formatMoney(bar.total)}
              </text>
            )}
            <text x={bar.x} y={baselineY + 17} textAnchor="middle" fontSize={10} fill="#8b95a5">
              {dayLabel(bar.date)}
            </text>
          </g>
        ))}
      </svg>
      {hovered && (
        <div
          style={{
            position: "absolute",
            left: `${(hovered.x / width) * 100}%`,
            top: `calc(${(hovered.y / height) * 100}% - 8px)`,
            transform: "translate(-50%, -100%)",
            background: "#18202b",
            color: "white",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 8px 20px rgba(0,0,0,.18)"
          }}
        >
          <strong>{formatMoney(hovered.total)}</strong>
          <div style={{ opacity: 0.75 }}>{fullDateLabel(hovered.date)}</div>
        </div>
      )}
    </div>
  );
}
