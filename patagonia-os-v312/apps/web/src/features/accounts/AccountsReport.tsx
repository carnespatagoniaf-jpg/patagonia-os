import { useEffect, useState } from "react";
import { formatMoney } from "../shifts/format";
import { listCustomerDebts, listSupplierDebts, type AccountDebt } from "./accounts-service";

/** Finanzas → "Reporte de cuentas" (migración 143, a pedido de Martínez): lo
 * que te deben los clientes y lo que le debés a los proveedores, en total y
 * por cada uno. */
export function AccountsReport() {
  const [customers, setCustomers] = useState<AccountDebt[]>([]);
  const [suppliers, setSuppliers] = useState<AccountDebt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [c, s] = await Promise.all([listCustomerDebts(), listSupplierDebts()]);
      setCustomers(c);
      setSuppliers(s);
    } catch {
      setError("No se pudo cargar el reporte. Probá de nuevo.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const totalCustomers = customers.reduce((sum, d) => sum + d.balance, 0);
  const totalSuppliers = suppliers.reduce((sum, d) => sum + d.balance, 0);
  const difference = totalCustomers - totalSuppliers;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">FINANZAS</p>
          <h1>Reporte de cuentas</h1>
          <p className="muted">Cuánto te deben tus clientes y cuánto le debés a tus proveedores, al día de hoy.</p>
        </div>
      </header>

      {error && <div className="message warning">{error}</div>}

      <div className="print-area">
        <p className="muted print-only-header">Reporte de cuentas · {new Date().toLocaleDateString("es-AR")}</p>
        <section className="panel">
          <div className="panel-title">
            <h2>Resumen</h2>
            <span className="no-print" style={{ display: "flex", gap: 8 }}>
              <button className="secondary" disabled={loading} onClick={() => void load()}>{loading ? "Cargando…" : "Actualizar"}</button>
              <button className="secondary" onClick={() => window.print()}>Imprimir</button>
            </span>
          </div>
          <div className="totals">
            <span>Te deben tus clientes <b>{formatMoney(totalCustomers)}</b></span>
            <span>Le debés a tus proveedores <b>{formatMoney(totalSuppliers)}</b></span>
            <strong>{difference >= 0 ? "A tu favor" : "En contra"} <b>{formatMoney(Math.abs(difference))}</b></strong>
          </div>
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            "A tu favor" = lo que te deben menos lo que debés. No cuenta la plata que ya tenés en caja (eso está en Tesorería).
          </p>
        </section>

        <div className="content-grid" style={{ marginTop: 18 }}>
          <DebtTable
            title="Lo que debo a mis proveedores"
            empty="No le debés nada a ningún proveedor."
            rows={suppliers}
            total={totalSuppliers}
            loading={loading}
          />
          <DebtTable
            title="Lo que me deben mis clientes"
            empty="Ningún cliente te debe."
            rows={customers}
            total={totalCustomers}
            loading={loading}
          />
        </div>
      </div>
    </>
  );
}

function DebtTable({ title, empty, rows, total, loading }: { title: string; empty: string; rows: AccountDebt[]; total: number; loading: boolean }) {
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>{title}</h2>
        <span>{loading ? "Cargando…" : `${rows.length}`}</span>
      </div>
      {!loading && rows.length === 0 && <p className="muted">{empty}</p>}
      {rows.length > 0 && (
        <table className="data-table">
          <thead>
            <tr><th>Nombre</th><th className="num">Saldo</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.number ? `${row.number} · ` : ""}{row.name}
                  {!row.active && <small className="muted"> (dado de baja)</small>}
                </td>
                <td className="num">{formatMoney(row.balance)}</td>
              </tr>
            ))}
            <tr>
              <td><strong>Total</strong></td>
              <td className="num"><strong>{formatMoney(total)}</strong></td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
