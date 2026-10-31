import { useEffect, useState } from "react";
import { listDailyChecks, type DailyCheck } from "./admin-service";
import { dailyCheckIssues } from "./daily-checks";

/**
 * "Para revisar hoy" (auditoría 29/10/2026): los clientes activos con algo para mirar, el que más problemas tiene
 * primero. Solo lee (migración 180). Sin la función todavía en la base, no muestra nada.
 */
export function AdminDailyChecks() {
  const [rows, setRows] = useState<DailyCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listDailyChecks()
      .then((r) => !cancelled && setRows(r))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "No se pudo cargar."));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return null;
  if (!rows) return <p className="muted">Revisando los clientes…</p>;
  const withIssues = rows.map((c) => ({ c, issues: dailyCheckIssues(c) })).filter((x) => x.issues.length > 0);

  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-title">
        <h2>Para revisar hoy</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          {withIssues.length === 0 ? "Todos los clientes activos están bien." : `${withIssues.length} de ${rows.length} clientes activos`}
        </span>
      </div>
      {withIssues.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Qué pasa</th>
              </tr>
            </thead>
            <tbody>
              {withIssues.map(({ c, issues }) => (
                <tr key={c.id}>
                  <td>
                    {c.name}
                    {c.inTrial && <span className="badge" style={{ marginLeft: 6 }}>prueba</span>}
                  </td>
                  <td>{issues.join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
