import { useEffect, useState } from "react";
import type { Product } from "@patagonia/domain";
import { AlertTriangle, Boxes, CircleDollarSign, ReceiptText, TrendingUp } from "lucide-react";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { useActiveBranch } from "../branches/BranchProvider";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listProfitabilityPeriods } from "../profitability/profitability-service";
import { formatMoney, todayIso } from "../shifts/format";
import { useShifts } from "../shifts/useShifts";
import { useTreasury } from "../shifts/useTreasury";

export function Dashboard() {
  const { profile } = useAuth();
  const { branchId } = useActiveBranch();
  const { balances } = useTreasury();
  const { loadRange } = useShifts();

  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [salesToday, setSalesToday] = useState(0);
  const [grossProfit, setGrossProfit] = useState<number | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!isSupabaseConfigured || !branchId) return;

    let cancelled = false;
    setLoading(true);
    const today = todayIso();

    Promise.all([listProductsForBranch(branchId), loadRange(today, today), listProfitabilityPeriods(branchId)])
      .then(([productList, shiftRows, periods]) => {
        if (cancelled) return;
        setProducts(productList);
        setSalesToday(shiftRows.flatMap((row) => row.sales).reduce((sum, sale) => sum + sale.amount, 0));
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
            <h2>Estado del negocio</h2>
            <span>Hoy</span>
          </div>
          <div className="empty-chart">
            <TrendingUp size={42} />
            <strong>El gráfico se alimentará con ventas reales</strong>
            <span>{isSupabaseConfigured ? "Cargá ventas desde Turnos o Mostrador" : "Supabase pendiente de conexión"}</span>
          </div>
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
