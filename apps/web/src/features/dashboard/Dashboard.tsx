import { AlertTriangle, Boxes, CircleDollarSign, ReceiptText, TrendingUp } from "lucide-react";
import { demoProducts } from "../../lib/demo-data";

export function Dashboard() {
  const stockValue = demoProducts.reduce((sum, p) => sum + p.stock * p.cost, 0);
  const alerts = demoProducts.filter((p) => p.stock <= p.minStock);

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">RESUMEN DE OPERACIÓN</p>
          <h1>Buenos días, Francisco</h1>
          <p className="muted">Datos de demostración hasta conectar Supabase.</p>
        </div>
        <span className="status-pill">V3.0 · Desarrollo</span>
      </header>

      <section className="kpi-grid">
        <Kpi title="Ventas hoy" value="$0" detail="0 tickets" icon={<CircleDollarSign />} />
        <Kpi title="Ganancia estimada" value="$0" detail="Margen pendiente" icon={<TrendingUp />} />
        <Kpi title="Caja actual" value="$0" detail="Sin movimientos" icon={<ReceiptText />} />
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
            <span>Supabase pendiente de conexión</span>
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

function formatMoney(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  }).format(value);
}
