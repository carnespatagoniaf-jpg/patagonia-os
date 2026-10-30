import { useEffect, useState } from "react";
import type { Product } from "@patagonia/domain";
import { isOverdueDebt } from "@patagonia/domain";
import { AlertTriangle, Boxes, CircleDollarSign, ReceiptText, TrendingUp } from "lucide-react";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { can, canAccessPage, type Page } from "../auth/permissions";
import { OnboardingCard } from "../onboarding/OnboardingCard";
import { useAuth } from "../auth/AuthProvider";
import { useActiveBranch } from "../branches/BranchProvider";
import { listCustomerChargesInRange, listCustomersWithBalance } from "../customers/customers-service";
import { listProductsForBranch } from "../inventory/inventory-service";
import { getReconReminders, getTransferAlerts, type ReconReminder } from "../reconciliation/reconciliation-service";
import { chequeAlerts, type ChequeAlerts } from "../cheques/cheque-logic";
import { getTaxCalendarInputs } from "../accounting/accounting-service";
import { daysLeftLabel, dueDateLabel, upcomingDues, type DueItem } from "../accounting/tax-calendar";
import { listOpenCheques } from "../cheques/cheques-service";
import { listPosSalesInRange, listSalesByProduct } from "../sale/pos-shift-service";
import { addDaysIso, formatMoney, todayIso } from "../shifts/format";
import { stockValueReport } from "../shifts/stock-value";
import { useShifts } from "../shifts/useShifts";
import { useTreasury } from "../shifts/useTreasury";

interface DaySales {
  date: string;
  total: number;
}

/** Saludo según la hora de Argentina (antes decía "Buenos días" a cualquier hora). */
function greeting(now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("es-AR", { hour: "numeric", hourCycle: "h23", timeZone: "America/Argentina/Buenos_Aires" }).format(now));
  if (hour >= 5 && hour < 13) return "Buenos días";
  if (hour >= 13 && hour < 20) return "Buenas tardes";
  return "Buenas noches";
}

export function Dashboard({ onNavigate }: { onNavigate?: (page: Page) => void } = {}) {
  const { profile } = useAuth();
  const { branchId } = useActiveBranch();
  const { balances } = useTreasury();
  const { loadRange } = useShifts();

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [salesToday, setSalesToday] = useState(0);
  const [salesSeries, setSalesSeries] = useState<DaySales[]>([]);
  /** Ganancia del mes en curso: vendido en Mostrador − costo de lo vendido (antes: solo el último período cerrado en Rentabilidad, y mostraba una raya). */
  const [grossProfit, setGrossProfit] = useState<{ profit: number; sales: number } | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [overdueCustomers, setOverdueCustomers] = useState<{ name: string; balance: number }[]>([]);
  const [transferAlerts, setTransferAlerts] = useState<{ count: number; total: number; oldest: string } | null>(null);
  const [statementReminders, setStatementReminders] = useState<ReconReminder[]>([]);
  const [chequeWarnings, setChequeWarnings] = useState<ChequeAlerts | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured || !branchId) return;

    let cancelled = false;
    setLoading(true);
    const today = todayIso();
    const weekAgo = addDaysIso(today, -6);

    Promise.all([
      listProductsForBranch(branchId),
      loadRange(weekAgo, today),
      can(profile, "treasury.manage") ? listSalesByProduct(branchId, `${today.slice(0, 7)}-01`, today).catch(() => null) : Promise.resolve(null),
      listPosSalesInRange(branchId, weekAgo, today),
      can(profile, "customers.manage") ? listCustomerChargesInRange(branchId, weekAgo, today) : Promise.resolve([]),
      can(profile, "customers.manage") ? listCustomersWithBalance() : Promise.resolve([])
    ])
      .then(([productList, shiftRows, monthRows, mostradorSales, customerCharges, customers]) => {
        if (cancelled) return;
        setProducts(productList);
        setOverdueCustomers(
          customers.filter((c) => isOverdueDebt(c, today)).map((c) => ({ name: c.name, balance: c.balance }))
        );

        const turnosByDate = new Map<string, number>();
        for (const row of shiftRows) {
          const dayTotal = row.sales.reduce((sum, sale) => sum + sale.amount, 0);
          turnosByDate.set(row.shift.shiftDate, (turnosByDate.get(row.shift.shiftDate) ?? 0) + dayTotal);
        }
        const mostradorByDate = new Map<string, number>();
        for (const sale of mostradorSales) {
          mostradorByDate.set(sale.date, (mostradorByDate.get(sale.date) ?? 0) + sale.amount);
        }
        const entregasByDate = new Map<string, number>();
        for (const charge of customerCharges) {
          entregasByDate.set(charge.date, (entregasByDate.get(charge.date) ?? 0) + charge.amount);
        }

        const series: DaySales[] = [];
        for (let i = 6; i >= 0; i--) {
          const date = addDaysIso(today, -i);
          series.push({
            date,
            total: (turnosByDate.get(date) ?? 0) + (mostradorByDate.get(date) ?? 0) + (entregasByDate.get(date) ?? 0)
          });
        }
        setSalesSeries(series);
        setSalesToday(series[series.length - 1]?.total ?? 0);
        if (monthRows) {
          const sales = monthRows.reduce((sum, r) => sum + r.amount, 0);
          const cost = monthRows.reduce((sum, r) => sum + r.cost, 0);
          setGrossProfit({ profit: sales - cost, sales });
        } else {
          setGrossProfit(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [branchId, loadRange, profile]);

  // Conciliación (plan Full): cobros por transferencia/QR que no llegaron al banco.
  useEffect(() => {
    if (!isSupabaseConfigured || !canAccessPage(profile, "reconciliation")) return;
    let cancelled = false;
    getTransferAlerts(null)
      .then((list) => {
        if (cancelled || list.length === 0) return;
        setTransferAlerts({ count: list.length, total: list.reduce((s, a) => s + a.amount, 0), oldest: list[0].date });
      })
      .catch(() => undefined);
    getReconReminders()
      .then((list) => {
        if (!cancelled) setStatementReminders(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [profile]);

  // Cheques (plan Full): qué depositar, qué vence y cuánto te debitan esta semana.
  useEffect(() => {
    if (!isSupabaseConfigured || !canAccessPage(profile, "cheques")) return;
    let cancelled = false;
    listOpenCheques()
      .then((list) => {
        if (!cancelled) setChequeWarnings(chequeAlerts(list, todayIso()));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [profile]);

  // Vencimientos de impuestos de los próximos 7 días (Contable, plan Full; migración 156).
  const [taxDues, setTaxDues] = useState<DueItem[]>([]);
  useEffect(() => {
    if (!isSupabaseConfigured || !canAccessPage(profile, "accounting") || profile?.role === "accountant") return;
    let cancelled = false;
    getTaxCalendarInputs()
      .then((inputs) => {
        if (cancelled) return;
        const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
        const { items } = upcomingDues({
          today,
          cuit: inputs.cuit,
          taxCondition: inputs.taxCondition,
          obligations: inputs.settings?.obligations ?? null,
          official: inputs.official,
          reminders: inputs.reminders,
          iibbDueDay: inputs.settings?.dueDay ?? null,
          horizonDays: 7
        });
        setTaxDues(items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [profile]);

  const chequeRows = chequeWarnings
    ? [
        chequeWarnings.expiring.count > 0 && {
          key: "expiring",
          title: `${chequeWarnings.expiring.count} ${chequeWarnings.expiring.count === 1 ? "cheque está" : "cheques están"} por vencer`,
          detail: `Suman ${formatMoney(chequeWarnings.expiring.total)} · un cheque se deposita hasta 30 días después de su fecha · Finanzas → Cheques`
        },
        chequeWarnings.toDeposit.count > chequeWarnings.expiring.count && {
          key: "deposit",
          title: `${chequeWarnings.toDeposit.count} ${chequeWarnings.toDeposit.count === 1 ? "cheque para depositar" : "cheques para depositar"} esta semana`,
          detail: `Suman ${formatMoney(chequeWarnings.toDeposit.total)} · Finanzas → Cheques`
        },
        chequeWarnings.toDebit.count > 0 && {
          key: "debit",
          title: `Te debitan ${formatMoney(chequeWarnings.toDebit.total)} en cheques propios`,
          detail: `${chequeWarnings.toDebit.count} ${chequeWarnings.toDebit.count === 1 ? "cheque" : "cheques"} en los próximos 7 días · tené la plata en el banco`
        }
      ].filter((r): r is { key: string; title: string; detail: string } => Boolean(r))
    : [];

  const cashOnHand = balances.reduce((sum, balance) => sum + balance.balance, 0);
  // La MISMA cuenta que Reportes → Stock valorizado (una sola función: antes eran dos cuentas distintas y daban
  // distinto; real M2 26/10, los huevos se sumaban 4 veces por las presentaciones).
  const stockValue = stockValueReport(products, []).costValue;
  // Solo lo que de verdad hay que mirar: productos con un mínimo cargado que llegaron a él, o en negativo.
  // Sin mínimo y en 0 no avisa (un negocio nuevo veía una alerta por cada producto; real M2 Alimentos, 24/10).
  // Las presentaciones usan el stock del principal: no se repite la alerta (real M2: los huevos aparecían 4 veces).
  const ownStock = products.filter((p) => !p.stockSourceId);
  const negativeAlerts = ownStock.filter((p) => p.stock < 0);
  const minimumAlerts = ownStock.filter((p) => p.stock >= 0 && p.minStock > 0 && p.stock <= p.minStock);
  const alerts = [...negativeAlerts, ...minimumAlerts];
  const firstName = profile?.full_name?.split(" ")[0] ?? "Usuario";

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">RESUMEN DE OPERACIÓN</p>
          <h1>{greeting()}, {firstName}</h1>
          <p className="muted">
            {isSupabaseConfigured ? (loading ? "Cargando datos…" : "Datos en vivo de tu empresa.") : "Datos de demostración hasta conectar Supabase."}
          </p>
        </div>
        <span className="status-pill">V3.1 · {isSupabaseConfigured ? "En vivo" : "Desarrollo"}</span>
      </header>

      {isSupabaseConfigured && (profile?.role === "owner" || profile?.role === "admin") && <OnboardingCard onNavigate={onNavigate} usesPos={can(profile, "pos.sell")} />}

      <section className="kpi-grid">
        <Kpi title="Ventas hoy" value={formatMoney(salesToday)} detail={`${salesToday === 0 ? "Sin" : ""} tickets de hoy`} icon={<CircleDollarSign />} />
        <Kpi
          title="Ganancia del mes"
          value={grossProfit !== null ? formatMoney(grossProfit.profit) : "—"}
          detail={
            grossProfit === null
              ? "Solo la ve el dueño o un administrador"
              : grossProfit.sales > 0
                ? `Vendido ${formatMoney(grossProfit.sales)} − lo que costó · ${Math.round((grossProfit.profit / grossProfit.sales) * 100)}% de lo vendido`
                : "Todavía no hay ventas este mes"
          }
          icon={<TrendingUp />}
        />
        <Kpi title="Caja actual" value={formatMoney(cashOnHand)} detail={`${balances.length} cuentas`} icon={<ReceiptText />} />
        <Kpi title="Stock valorizado" value={formatMoney(stockValue)} detail={`${alerts.length} alertas`} icon={<Boxes />} />
      </section>

      <section className="content-grid">
        <div className="panel">
          <div className="panel-title">
            <h2>Ventas</h2>
            <span className="muted">Últimos 7 días · Turnos + Mostrador + Entregas a cuenta corriente</span>
          </div>
          {salesSeries.some((d) => d.total > 0) ? (
            <SalesTrendChart series={salesSeries} />
          ) : (
            <div className="empty-chart">
              <TrendingUp size={42} />
              <strong>Sin ventas en los últimos 7 días</strong>
              <span>{isSupabaseConfigured ? "Cargá ventas desde Mostrador" : "Supabase pendiente de conexión"}</span>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">
            <h2>Alertas</h2>
            <AlertTriangle size={20} />
          </div>
          {alerts.length === 0 && overdueCustomers.length === 0 && !transferAlerts && statementReminders.length === 0 && chequeRows.length === 0 && taxDues.length === 0 ? (
            <p className="muted">Sin alertas.</p>
          ) : (
            <>
              {taxDues.map((d) => (
                <div className="alert-row" key={`due-${d.date}-${d.title}`}>
                  <AlertTriangle size={18} />
                  <div>
                    <strong>Vence {d.title} {daysLeftLabel(d.daysLeft)}</strong>
                    <span>
                      {dueDateLabel(d.date)}
                      {d.kind === "estimada" ? " (fecha estimada, confirmala en ARCA)" : ""} · Finanzas → Contable
                    </span>
                  </div>
                </div>
              ))}
              {chequeRows.map((r) => (
                <div className="alert-row" key={`cheque-${r.key}`}>
                  <AlertTriangle size={18} />
                  <div>
                    <strong>{r.title}</strong>
                    <span>{r.detail}</span>
                  </div>
                </div>
              ))}
              {transferAlerts && (
                <div className="alert-row">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>{transferAlerts.count} {transferAlerts.count === 1 ? "cobro por transferencia no llegó" : "cobros por transferencia no llegaron"} al banco</strong>
                    <span>
                      Suman {formatMoney(transferAlerts.total)} · desde el {transferAlerts.oldest.split("-").reverse().join("/")} · revisalos en Finanzas → Conciliación
                    </span>
                  </div>
                </div>
              )}
              {statementReminders.map((r) => (
                <div className="alert-row" key={`statement-${r.reconAccountId}`}>
                  <AlertTriangle size={18} />
                  <div>
                    <strong>Subí el resumen de {r.name}</strong>
                    <span>
                      {r.lastLineDate
                        ? `El último llega hasta el ${r.lastLineDate.split("-").reverse().join("/")} (hace ${r.daysBehind} días). Sin eso no se controla si llegaron las transferencias.`
                        : "Todavía no se subió ninguno. Sin eso no se controla si llegaron las transferencias."}
                    </span>
                  </div>
                </div>
              ))}
              {overdueCustomers.map((c) => (
                <div className="alert-row" key={`overdue-${c.name}`}>
                  <AlertTriangle size={18} />
                  <div>
                    <strong>{c.name} está atrasado</strong>
                    <span>Te debe {formatMoney(c.balance)} y ya pasó su plazo</span>
                  </div>
                </div>
              ))}
              {/* Negativos juntos en una línea: un local que vende sin cargar compras tenía una alerta por producto (Pollo y mar: 175). */}
              {negativeAlerts.length > 3 ? (
                <div className="alert-row">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>{negativeAlerts.length} productos en negativo</strong>
                    <span>Se vendió más de lo cargado. Cargá las compras o corregí con Stock → "Ajustar stock" ({negativeAlerts.slice(0, 3).map((p) => p.name).join(", ")}…)</span>
                  </div>
                </div>
              ) : (
                negativeAlerts.map((product) => (
                  <div className="alert-row" key={product.id}>
                    <AlertTriangle size={18} />
                    <div>
                      <strong>{product.name}</strong>
                      <span>En negativo: {product.stock} {product.unit === "kg" ? "kg" : "u."} · se vendió más de lo cargado</span>
                    </div>
                  </div>
                ))
              )}
              {minimumAlerts.slice(0, 8).map((product) => (
                <div className="alert-row" key={product.id}>
                  <AlertTriangle size={18} />
                  <div>
                    <strong>{product.name}</strong>
                    <span>Queda {product.stock} {product.unit === "kg" ? "kg" : "u."} · mínimo {product.minStock}</span>
                  </div>
                </div>
              ))}
              {minimumAlerts.length > 8 && <p className="muted" style={{ fontSize: 12 }}>Y {minimumAlerts.length - 8} productos más llegaron a su mínimo (Stock, marcados con ⚠).</p>}
            </>
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
