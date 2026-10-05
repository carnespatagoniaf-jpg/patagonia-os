// Oculto del panel de administrador desde 2026-10-05 (pedido del dueño: "esto borralo").
// Los reportes se siguen guardando en la base (scale_support_reports); para volver
// a verlos, montar <AdminScaleReports /> otra vez en AdminCreateClient.tsx.
import { useCallback, useEffect, useState } from "react";
import { Scale } from "lucide-react";
import { listScaleSupportReports, setScaleSupportReportResolved, type ScaleSupportReport } from "./admin-service";

/** Reportes de balanzas que mandan los clientes con "Enviar a soporte"
 * (pantalla Balanzas). Las balanzas se prueban en el local del cliente sin
 * nadie de Patagonia OS al lado: esto es lo que pasó allá, con el nombre del cliente. */
export function AdminScaleReports() {
  const [reports, setReports] = useState<ScaleSupportReport[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setReports(await listScaleSupportReports());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los reportes de balanzas.");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggleResolved(report: ScaleSupportReport) {
    setBusyId(report.id);
    try {
      await setScaleSupportReportResolved(report.id, !report.resolvedAt);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el reporte.");
    } finally {
      setBusyId(null);
    }
  }

  function fullText(report: ScaleSupportReport) {
    return [
      `Cliente: ${report.companyName}${report.branchName ? ` · ${report.branchName}` : ""}`,
      `Enviado por: ${report.userName ?? "-"} · ${new Date(report.createdAt).toLocaleString("es-AR")}`,
      `Nota: ${report.note ?? "-"}`,
      `Navegador: ${report.userAgent ?? "-"}`,
      `Balanzas configuradas: ${JSON.stringify(report.connections, null, 2)}`,
      "Actividad:",
      report.logText
    ].join("\n");
  }

  const pending = reports.filter((r) => !r.resolvedAt);
  if (!error && reports.length === 0) return null;

  return (
    <section className="admin-trial-alert">
      <strong>
        <Scale size={16} style={{ verticalAlign: "-3px" }} /> Reportes de balanzas {pending.length > 0 ? `· ${pending.length} sin resolver` : "· todos resueltos"}
      </strong>
      {error && <p className="message warning">{error}</p>}
      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
        {reports.map((report) => (
          <details key={report.id} style={{ opacity: report.resolvedAt ? 0.6 : 1 }}>
            <summary style={{ cursor: "pointer" }}>
              {report.resolvedAt ? "✓ " : ""}
              <strong>{report.companyName}</strong>
              {report.branchName ? ` · ${report.branchName}` : ""} · {new Date(report.createdAt).toLocaleString("es-AR")}
              {report.note ? ` — "${report.note}"` : ""}
            </summary>
            <div style={{ marginTop: 8 }}>
              <p className="muted" style={{ margin: "0 0 6px", fontSize: 13 }}>
                Enviado por {report.userName ?? "-"} · {report.connections.length} balanza(s) configurada(s)
              </p>
              <pre style={{ maxHeight: 260, overflowY: "auto", background: "#f7f7f8", borderRadius: 6, padding: 10, fontSize: 12, whiteSpace: "pre-wrap", margin: "0 0 8px" }}>
                {fullText(report)}
              </pre>
              <div className="admin-actions">
                <button
                  className="secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(fullText(report));
                    setCopiedId(report.id);
                  }}
                >
                  {copiedId === report.id ? "¡Copiado!" : "Copiar todo"}
                </button>
                <button className="secondary" disabled={busyId === report.id} onClick={() => void toggleResolved(report)}>
                  {report.resolvedAt ? "Marcar sin resolver" : "Marcar resuelto"}
                </button>
              </div>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
