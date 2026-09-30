import type { TransferAlert } from "./reconciliation-service";

/**
 * Cobros cargados en Mostrador como transferencia/QR que ya deberían verse en
 * el banco y no aparecen (ni con un importe parecido): la estafa del
 * comprobante falso, o un cobro cargado en la cuenta equivocada. Migración 106.
 */

const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n: number) => money.format(n);
const fmtDate = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");

export function TransferAlerts({ alerts }: { alerts: TransferAlert[] }) {
  if (alerts.length === 0) return null;
  const total = alerts.reduce((s, a) => s + a.amount, 0);
  const byCashier = new Map<string, { count: number; total: number }>();
  for (const a of alerts) {
    const r = byCashier.get(a.cashier) ?? { count: 0, total: 0 };
    r.count++;
    r.total += a.amount;
    byCashier.set(a.cashier, r);
  }
  return (
    <div style={{ border: "2px solid #f0b4a8", background: "#fff6f4", borderRadius: 10, padding: 16, marginTop: 16 }}>
      <p style={{ margin: "0 0 6px", fontWeight: 700, color: "#8a1f11" }}>
        ⚠ {alerts.length} {alerts.length === 1 ? "cobro que no llegó" : "cobros que no llegaron"} al banco · {fmt(total)}
      </p>
      <p style={{ margin: "0 0 10px", fontSize: 13 }}>
        Se cobraron en Mostrador como transferencia o QR hace más de 3 días y en el resumen del banco no aparece nada parecido. Puede ser un comprobante falso, un cobro cargado en la cuenta equivocada o con otro importe. Revisalos con quien cobró.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {Array.from(byCashier.entries()).map(([cashier, r]) => (
          <span key={cashier} style={{ background: "#fff", border: "1px solid #f0b4a8", borderRadius: 999, padding: "3px 10px", fontSize: 13 }}>
            {cashier}: <strong>{r.count}</strong> · {fmt(r.total)}
          </span>
        ))}
      </div>
      <details open={alerts.length <= 10}>
        <summary style={{ cursor: "pointer" }}>Ver uno por uno</summary>
        <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto", marginTop: 8 }}>
          <table className="data-table">
            <thead>
              <tr><th>Fecha</th><th>Cobró</th><th>Cuenta</th><th>Operación</th><th className="num">Importe</th></tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td>{fmtDate(a.date)} {a.time}</td>
                  <td>{a.cashier}{a.branchName ? <span className="muted"> · {a.branchName}</span> : null}</td>
                  <td>{a.accountName}</td>
                  <td>{a.reference ?? <span className="muted">—</span>}</td>
                  <td className="num">{fmt(a.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
