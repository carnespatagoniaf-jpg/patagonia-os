import { useEffect, useMemo, useState } from "react";
import { listCustomersWithBalance } from "../customers/customers-service";
import { formatMoney } from "../shifts/format";
import { listPaymentsInRange } from "./accounts-service";
import { shortDay, summarizePayments, type ReportPayment } from "./sales-report";

const dmy = (iso: string) => iso.split("-").reverse().join("/");

/** Reporte de ventas → "Pagos" (a pedido de Martínez, 03/11/2026): cuánto pagaron los clientes en un período,
 * en qué cuenta entró, por cliente con lo que debe hoy, y el detalle por día. Va dentro del .print-area de la
 * pantalla, así sale en el mismo "Guardar PDF". */
export function PaymentsReport({ from, to }: { from: string; to: string }) {
  const [payments, setPayments] = useState<ReportPayment[]>([]);
  const [balances, setBalances] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void Promise.all([listPaymentsInRange(from, to), listCustomersWithBalance(true).catch(() => [])])
      .then(([list, customers]) => {
        if (cancelled) return;
        setPayments(list);
        setBalances(new Map(customers.map((c) => [c.id, c.balance])));
      })
      .catch(() => !cancelled && setError("No se pudieron cargar los pagos. Probá de nuevo."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const summary = useMemo(() => summarizePayments(payments), [payments]);

  return (
    <>
      {error && <div className="message warning">{error}</div>}

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Pagos del {dmy(from)} al {dmy(to)}</h2>
          <span>{loading ? "Cargando…" : `${summary.count} pagos`}</span>
        </div>
        <div className="totals">
          <span>Pagos <b>{summary.count}</b></span>
          <strong>Total cobrado <b>{formatMoney(summary.total)}</b></strong>
        </div>
        {summary.byAccount.length > 0 && (
          <table className="data-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Entró a</th>
                <th className="num">Pagos</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {summary.byAccount.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td className="num">{a.count}</td>
                  <td className="num">{formatMoney(a.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {summary.byCustomer.length > 0 && (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Por cliente</h2>
            <span>"Debe hoy" es el saldo de hoy, no el del {dmy(to)}</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Cliente</th>
                <th className="num">Pagos</th>
                <th className="num">Pagó</th>
                <th className="num">Debe hoy</th>
              </tr>
            </thead>
            <tbody>
              {summary.byCustomer.map((c) => {
                const balance = balances.get(c.customerId);
                return (
                  <tr key={c.customerId}>
                    <td>{c.name}</td>
                    <td className="num">{c.count}</td>
                    <td className="num">{formatMoney(c.total)}</td>
                    <td className="num">{balance === undefined ? "—" : balance > 0 ? formatMoney(balance) : balance < 0 ? `a favor ${formatMoney(-balance)}` : "al día"}</td>
                  </tr>
                );
              })}
              <tr>
                <td><strong>Total</strong></td>
                <td className="num"><strong>{summary.count}</strong></td>
                <td className="num"><strong>{formatMoney(summary.total)}</strong></td>
                <td />
              </tr>
            </tbody>
          </table>
        </section>
      )}

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-title">
          <h2>Detalle de los pagos</h2>
        </div>
        {!loading && summary.count === 0 && <p className="muted">No hay pagos en esas fechas.</p>}
        {summary.byDay.map((day) => (
          <div key={day.date} style={{ marginBottom: 14 }}>
            <div className="list-row" style={{ borderBottom: "2px solid #ddd" }}>
              <strong>{shortDay(day.date)}</strong>
              <strong>{formatMoney(day.total)}</strong>
            </div>
            <table className="data-table">
              <tbody>
                {day.payments.map((p) => (
                  <tr key={p.id}>
                    <td style={{ width: "40%" }}>
                      <strong>{p.customerName}</strong>
                      {p.notes && <div className="muted" style={{ fontSize: 12 }}>{p.notes}</div>}
                    </td>
                    <td>{p.accountName ?? <span className="muted">Sin cuenta</span>}</td>
                    <td className="num" style={{ width: "18%" }}><strong>{formatMoney(p.amount)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>
    </>
  );
}
