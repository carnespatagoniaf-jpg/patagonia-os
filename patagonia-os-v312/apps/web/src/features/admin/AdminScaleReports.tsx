// Pestaña "Soporte" del panel de administrador (2026-10-17). Estuvo oculta desde
// 2026-10-05 ("esto borralo": molestaba en medio de Clientes); volvió en su propia
// pestaña para que los errores que mandan los clientes se vean en algún lado.
import { useCallback, useEffect, useState } from "react";
import { Scale } from "lucide-react";
import { listScaleSupportReports, setScaleSupportReportResolved, type ScaleSupportReport } from "./admin-service";
import { Alert, Badge, Button, Card, EmptyState, useConfirm } from "./ui/components";
import { redactSensitive } from "./scale-center";

/** Reportes de balanzas que mandan los clientes con "Enviar a soporte"
 * (pantalla Balanzas). Las balanzas se prueban en el local del cliente sin
 * nadie nuestro al lado: esto es lo que pasó allá, con el nombre del cliente. */
export function AdminScaleReports({ onChange }: { onChange?: () => void } = {}) {
  const [reports, setReports] = useState<ScaleSupportReport[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [ask, confirmDialog] = useConfirm();

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
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el reporte.");
    } finally {
      setBusyId(null);
    }
  }

  async function resolveAll() {
    const open = reports.filter((r) => !r.resolvedAt);
    if (!(await ask({ title: `¿Marcar los ${open.length} reportes como resueltos?`, confirmLabel: "Marcar resueltos" }))) return;
    setBusyId("all");
    try {
      for (const r of open) await setScaleSupportReportResolved(r.id, true);
      await reload();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron marcar los reportes.");
    } finally {
      setBusyId(null);
    }
  }

  function fullText(report: ScaleSupportReport) {
    return [
      `Cliente: ${report.companyName}${report.branchName ? ` · ${report.branchName}` : ""}`,
      `Enviado por: ${report.userName ?? "-"} · ${new Date(report.createdAt).toLocaleString("es-AR", { hourCycle: "h23" })}`,
      `Nota: ${report.note ?? "-"}`,
      `Navegador: ${report.userAgent ?? "-"}`,
      `Balanzas configuradas: ${redactSensitive(JSON.stringify(report.connections, null, 2))}`,
      "Actividad:",
      redactSensitive(report.logText)
    ].join("\n");
  }

  const pending = reports.filter((r) => !r.resolvedAt);

  return (
    <Card
      title={<span className="pa-row"><Scale size={16} aria-hidden /> Reportes de balanzas</span>}
      subtitle={reports.length === 0 ? undefined : pending.length > 0 ? `${pending.length} sin resolver` : "Todos resueltos"}
      actions={pending.length > 1 ? <Button variant="secondary" size="sm" loading={busyId === "all"} onClick={() => void resolveAll()}>Marcar los {pending.length} como resueltos</Button> : undefined}
    >
      {error && <Alert tone="warn" onClose={() => setError("")}>{error}</Alert>}
      {!error && reports.length === 0 && (
        <EmptyState icon={Scale} title="No hay reportes de balanzas">Cuando un cliente toque “Enviar a soporte” (o la balanza dé un error), aparece acá.</EmptyState>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {reports.map((report) => (
          <details key={report.id} className="pa-list-row pa-report" style={{ opacity: report.resolvedAt ? 0.65 : 1 }}>
            <summary>
              <span className="pa-row" style={{ gap: 8, display: "inline-flex" }}>
                {report.resolvedAt ? <Badge tone="ok">Resuelto</Badge> : <Badge tone="warn">Sin resolver</Badge>}
                <strong>{report.companyName}</strong>
                <span className="pa-muted" style={{ fontWeight: 400 }}>
                  {report.branchName ? `${report.branchName} · ` : ""}{new Date(report.createdAt).toLocaleString("es-AR", { hourCycle: "h23" })}
                  {report.note ? ` — “${report.note}”` : ""}
                </span>
              </span>
            </summary>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <span className="pa-muted" style={{ fontSize: 13 }}>
                Enviado por {report.userName ?? "-"} · {report.connections.length} balanza(s) configurada(s)
              </span>
              <pre className="pa-pre">{fullText(report)}</pre>
              <div className="pa-row">
                <Button variant="secondary" size="sm" onClick={() => { void navigator.clipboard.writeText(fullText(report)); setCopiedId(report.id); }}>
                  {copiedId === report.id ? "¡Copiado!" : "Copiar todo"}
                </Button>
                <Button variant="secondary" size="sm" loading={busyId === report.id} onClick={() => void toggleResolved(report)}>
                  {report.resolvedAt ? "Marcar sin resolver" : "Marcar resuelto"}
                </Button>
              </div>
            </div>
          </details>
        ))}
      </div>
      {confirmDialog}
    </Card>
  );
}
