import { formatMoney } from "../shifts/format";
import type { AgingRow } from "./accounting-service";

/** Antigüedad de saldos (migración 156): quién debe y hace cuánto. */
export function AgingPanel({ aging, loading }: { aging: { asOf: string; receivables: AgingRow[]; payables: AgingRow[] } | null; loading: boolean }) {
  if (loading && !aging) return <p className="muted" style={{ marginTop: 18 }}>Cargando…</p>;
  if (!aging) return null;
  return (
    <>
      <AgingTable title="Lo que te deben los clientes" who="Cliente" rows={aging.receivables} empty="Ningún cliente te debe." />
      <AgingTable title="Lo que les debés a los proveedores" who="Proveedor" rows={aging.payables} empty="No le debés a ningún proveedor." />
      <p className="setting-help">
        Al {aging.asOf.split("-").reverse().join("/")}. Cada pago se cuenta primero contra lo más viejo, como hacen los bancos y las empresas grandes. "Más de 90 días" es lo que conviene reclamar primero.
      </p>
    </>
  );
}

function AgingTable({ title, who, rows, empty }: { title: string; who: string; rows: AgingRow[]; empty: string }) {
  const sum = (k: keyof AgingRow) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const total = sum("balance");
  const old = sum("b90");
  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-title">
        <h2>{title}</h2>
        <span>
          {formatMoney(total)}
          {old > 0 && <span className="num-negative"> · {formatMoney(old)} hace más de 90 días</span>}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{who}</th>
                <th className="num">Saldo</th>
                <th className="num">0 a 30 días</th>
                <th className="num">31 a 60</th>
                <th className="num">61 a 90</th>
                <th className="num">Más de 90</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name + (r.taxId ?? "")}>
                  <td>
                    {r.name}
                    {(r.phone || r.oldest) && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {r.phone ?? ""}{r.phone && r.oldest ? " · " : ""}{r.oldest ? `desde el ${r.oldest.split("-").reverse().join("/")}` : ""}
                      </div>
                    )}
                  </td>
                  <td className="num"><strong>{formatMoney(r.balance)}</strong></td>
                  <td className="num">{r.b0_30 ? formatMoney(r.b0_30) : "—"}</td>
                  <td className="num">{r.b31_60 ? formatMoney(r.b31_60) : "—"}</td>
                  <td className="num">{r.b61_90 ? formatMoney(r.b61_90) : "—"}</td>
                  <td className={r.b90 ? "num num-negative" : "num"}>{r.b90 ? formatMoney(r.b90) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td><strong>Total</strong></td>
                <td className="num"><strong>{formatMoney(total)}</strong></td>
                <td className="num">{formatMoney(sum("b0_30"))}</td>
                <td className="num">{formatMoney(sum("b31_60"))}</td>
                <td className="num">{formatMoney(sum("b61_90"))}</td>
                <td className="num">{formatMoney(old)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
