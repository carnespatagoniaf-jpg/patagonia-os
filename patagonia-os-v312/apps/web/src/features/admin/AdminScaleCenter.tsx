// Pestaña "Balanzas" del panel de plataforma (2026-11-27, migración 230): el Centro de diagnóstico de balanzas.
// Para que soporte vea qué pasa con las balanzas de cada cliente sin entrar a la PC del local. Es de LECTURA:
// lo único que escribe es "Marcar resuelto" (set_scale_support_report_resolved, el mismo de AdminScaleReports).
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Copy, FileText, RefreshCw, Scale } from "lucide-react";
import { setScaleSupportReportResolved } from "./admin-service";
import { AdminScaleReports } from "./AdminScaleReports";
import { AdminScaleConnectVersions, CompanyChannelSelect } from "./AdminScaleConnectVersions";
import {
  ago,
  classifyScaleCause,
  describeBrands,
  filterOverview,
  groupByCause,
  parseReportLog,
  redactSensitive,
  type Light
} from "./scale-center";
import {
  fetchScaleCompanyDetail,
  fetchScaleOverview,
  fetchScaleReportLog,
  type ScaleCompanyDetail,
  type ScaleDetailReport,
  type ScaleDetailScale,
  type ScaleOverviewRow,
  type ScaleReportLog
} from "./scale-center-service";
import { installSummary, type InstallRecord } from "../scales/install-status";
import { Alert, Badge, Button, Card, EmptyState, Input, Kpi, Modal, Skeleton, type Tone } from "./ui/components";

const LIGHT_TONE: Record<Light, Tone> = { verde: "ok", amarillo: "warn", rojo: "danger" };
const LIGHT_LABEL: Record<Light, string> = { verde: "Bien", amarillo: "Revisar", rojo: "Problema" };
const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  done: { label: "Bien", tone: "ok" },
  partial: { label: "A medias", tone: "warn" },
  failed: { label: "Falló", tone: "danger" },
  queued: { label: "Esperando PC", tone: "info" },
  running: { label: "En curso", tone: "info" }
};
const JOB_KIND: Record<string, string> = { send: "Envío", test: "Prueba", read: "Lectura" };
const PLAN_LABEL: Record<string, string> = { basico: "Básico", estandar: "Estándar", full: "Full", empresa: "Empresa", planta: "Planta" };

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("es-AR", { hourCycle: "h23", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-");
const capital = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const pairs = (o: Record<string, unknown> | null | undefined) =>
  o ? Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ") : "";

function labelSpecText(spec: ScaleDetailScale["labelSpec"]): string {
  if (!spec) return "Sin perfil (usa el formato de la sucursal)";
  const p = spec.prefixes ?? {};
  const parts = [p.weighed ? `por kilo ${p.weighed}` : null, p.unit ? `por unidad ${p.unit}` : null, p.total ? `total ${p.total}` : null].filter(Boolean);
  const w = spec.writer;
  const writer = w?.kind === "kretz1070" ? ` · 1070 ${w.code}` : w?.kind === "systel" ? ` · Systel ${w.weighed}/${w.unit}` : "";
  return `${parts.length ? `Inicios: ${parts.join(", ")}` : "Sin inicios"}${writer}`;
}

/** El reporte en palabras: etapa + mensaje, o la nota si es un reporte viejo. */
const reportCause = (r: Pick<ScaleDetailReport, "stage" | "message" | "technical" | "note">) => classifyScaleCause(r);

export function AdminScaleCenter({ onReportsChange }: { onReportsChange?: () => void } = {}) {
  const [rows, setRows] = useState<ScaleOverviewRow[] | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [query, setQuery] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await fetchScaleOverview());
      setError("");
      setMissing(false);
    } catch (err) {
      if ((err as { missing?: boolean }).missing) setMissing(true);
      else setError(err instanceof Error ? err.message : "No se pudo cargar el centro de balanzas.");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => filterOverview(rows ?? [], { onlyProblems, query }), [rows, onlyProblems, query]);
  const problems = (rows ?? []).filter((r) => r.light !== "verde").length;
  const companies = new Set((rows ?? []).map((r) => r.companyId)).size;
  const red = (rows ?? []).filter((r) => r.light === "rojo").length;
  const open = (rows ?? []).reduce((n, r) => n + r.reportsOpen, 0);
  const online = (rows ?? []).reduce((n, r) => n + r.connectorsOnline, 0);
  const connectors = (rows ?? []).reduce((n, r) => n + r.connectorsActive, 0);

  if (companyId) {
    return (
      <ScaleCompanyView
        companyId={companyId}
        rows={(rows ?? []).filter((r) => r.companyId === companyId)}
        onBack={() => { setCompanyId(null); void reload(); }}
        onReportsChange={() => { onReportsChange?.(); void reload(); }}
      />
    );
  }

  return (
    <>
      <Card
        title={<span className="pa-row"><Scale size={16} aria-hidden /> Centro de diagnóstico de balanzas</span>}
        subtitle="Qué pasa con las balanzas de cada cliente, sin entrar a su PC. Solo lectura."
        actions={<Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => { setRows(null); void reload(); }}>Actualizar</Button>}
      >
        {missing && <Alert tone="info" title="La base todavía no tiene el centro de diagnóstico">Falta aplicar la migración 230. Mientras tanto, abajo están los reportes que mandan los clientes.</Alert>}
        {error && <Alert tone="warn" onClose={() => setError("")}>{error}</Alert>}
        {rows === null ? <Skeleton lines={5} /> : !missing && (
          <>
            <div className="pa-kpis">
              <Kpi label="Clientes con balanzas" value={companies} />
              <Kpi label="Con problemas" value={problems} hint={red ? `${red} en rojo` : "Ninguno en rojo"} />
              <Kpi label="Reportes sin resolver" value={open} />
              <Kpi label="PC con Scale Connect en línea" value={`${online} de ${connectors}`} />
            </div>
            <div className="pa-table-tools">
              <div className="pa-chips" role="group" aria-label="Filtro">
                <button type="button" className="pa-chip" aria-pressed={!onlyProblems} onClick={() => setOnlyProblems(false)}>
                  Todos <span className="pa-chip-count">{rows.length}</span>
                </button>
                <button type="button" className="pa-chip" aria-pressed={onlyProblems} onClick={() => setOnlyProblems(true)}>
                  Con problemas <span className="pa-chip-count">{problems}</span>
                </button>
              </div>
              <label className="pa-search">
                <span className="pa-sr-only">Buscar cliente</span>
                <Input type="search" placeholder="Buscar cliente o sucursal" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
            </div>
            {visible.length === 0 ? (
              <EmptyState icon={Scale} title={rows.length === 0 ? "Ningún cliente tiene balanzas registradas" : "No hay clientes con ese filtro"}>
                {rows.length === 0 ? "Cuando un cliente registre una balanza, instale Scale Connect o mande un reporte, aparece acá." : "Probá con otro nombre o mirá todos."}
              </EmptyState>
            ) : (
              <div className="pa-table-wrap">
                <table className="pa-table">
                  <thead>
                    <tr>
                      <th>Estado</th>
                      <th>Cliente</th>
                      <th>Balanzas</th>
                      <th>Scale Connect</th>
                      <th>Último envío</th>
                      <th className="num">Fallados 7 días</th>
                      <th className="num">Reportes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr key={`${r.companyId}|${r.branchId ?? ""}`} className="clickable" onClick={() => setCompanyId(r.companyId)} tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter") setCompanyId(r.companyId); }}>
                        <td>
                          <Badge tone={LIGHT_TONE[r.light]}>{LIGHT_LABEL[r.light]}</Badge>
                          <div className="pa-muted" style={{ fontSize: 12, marginTop: 4 }}>{r.lightReason}</div>
                          {r.reportsOpen > 0 && (
                            <div className="pa-muted" style={{ fontSize: 12 }}>
                              Causa probable: {reportCause({ stage: r.lastOpenReportStage, message: r.lastOpenReportMessage, technical: null, note: null }).label}
                            </div>
                          )}
                        </td>
                        <td>
                          <strong>{r.companyName}</strong>{!r.companyActive && <> <Badge tone="neutral">Inactivo</Badge></>}
                          <div className="pa-muted" style={{ fontSize: 12 }}>
                            {r.branchName ?? "Sin sucursal"} · {PLAN_LABEL[r.plan ?? ""] ?? r.plan ?? "-"}{r.balanzasV2 ? " · Balanzas v2" : ""}
                          </div>
                        </td>
                        <td>
                          {describeBrands(r.scalesByBrand)}
                          {r.duplicateGroups > 0 && <div className="pa-text-warn" style={{ fontSize: 12 }}>{r.duplicateGroups === 1 ? "1 registro repetido" : `${r.duplicateGroups} registros repetidos`}</div>}
                        </td>
                        <td>
                          {r.connectorsActive === 0 ? <span className="pa-muted">Sin instalar</span> : (
                            <>
                              {r.connectorsOnline} de {r.connectorsActive} en línea
                              <div className="pa-muted" style={{ fontSize: 12 }}>
                                {r.connectorVersionMin === r.connectorVersionMax ? `v${r.connectorVersionMin ?? "?"}` : `v${r.connectorVersionMin} a v${r.connectorVersionMax}`} · latido {ago(r.connectorLastSeen)}
                              </div>
                            </>
                          )}
                        </td>
                        <td>
                          {r.lastJobAt ? (
                            <>
                              <Badge tone={JOB_STATUS[r.lastJobStatus ?? ""]?.tone ?? "neutral"}>{JOB_STATUS[r.lastJobStatus ?? ""]?.label ?? r.lastJobStatus}</Badge>
                              <div className="pa-muted" style={{ fontSize: 12 }}>{r.lastJobConfirmed ?? 0} de {r.lastJobRequested ?? 0} · {ago(r.lastJobAt)}</div>
                            </>
                          ) : <span className="pa-muted">Nunca</span>}
                          {r.jobsStuck > 0 && <div className="pa-text-danger" style={{ fontSize: 12 }}>{r.jobsStuck} esperando PC</div>}
                        </td>
                        <td className="num">{r.jobsFailed7d || "-"}</td>
                        <td className="num">{r.reportsOpen ? <strong className="pa-text-warn">{r.reportsOpen}</strong> : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
      {/* Versiones de Scale Connect publicadas y cuántas PC tiene cada una (migraciones 229 y 231). */}
      <AdminScaleConnectVersions />
      {/* La bandeja de todos los reportes (la de siempre), debajo: no se duplica, se reusa. */}
      <AdminScaleReports onChange={() => { onReportsChange?.(); void reload(); }} />
    </>
  );
}

function ScaleCompanyView({ companyId, rows, onBack, onReportsChange }: { companyId: string; rows: ScaleOverviewRow[]; onBack: () => void; onReportsChange: () => void }) {
  const [detail, setDetail] = useState<ScaleCompanyDetail | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<ScaleDetailReport | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await fetchScaleCompanyDetail(companyId));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el detalle.");
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleResolved(report: ScaleDetailReport) {
    setBusyId(report.id);
    try {
      await setScaleSupportReportResolved(report.id, !report.resolvedAt);
      await load();
      onReportsChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el reporte.");
    } finally {
      setBusyId(null);
    }
  }

  const groups = useMemo(() => (detail ? groupByCause(detail.reports, reportCause) : []), [detail]);
  const name = detail?.company.name ?? rows[0]?.companyName ?? "Cliente";

  return (
    <>
      <div className="pa-row">
        <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>Todos los clientes</Button>
      </div>
      <Card
        title={<span className="pa-row"><Scale size={16} aria-hidden /> {name}</span>}
        subtitle={detail ? `${PLAN_LABEL[detail.company.plan ?? ""] ?? detail.company.plan ?? "-"}${detail.company.balanzasV2 ? " · Balanzas v2 prendido" : " · Balanzas v2 apagado"}${detail.company.active ? "" : " · Cliente inactivo"}` : undefined}
        actions={<Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => void load()}>Actualizar</Button>}
      >
        {error && <Alert tone="warn" onClose={() => setError("")}>{error}</Alert>}
        {rows.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            {rows.map((r) => (
              <div key={r.branchId ?? "-"} className="pa-row">
                <Badge tone={LIGHT_TONE[r.light]}>{LIGHT_LABEL[r.light]}</Badge>
                <strong>{r.branchName ?? "Sin sucursal"}</strong>
                <span className="pa-muted">{r.lightReason}</span>
              </div>
            ))}
          </div>
        )}
        {!detail && !error && <Skeleton lines={4} />}
      </Card>

      {detail && (
        <>
          <Card title="Errores agrupados por causa" subtitle={groups.length ? "Según la etapa y el mensaje de cada reporte" : undefined}>
            {groups.length === 0 ? <p className="pa-muted">Este cliente no mandó reportes de balanzas.</p> : (
              <div style={{ display: "grid", gap: 8 }}>
                {groups.map((g) => (
                  <div key={g.cause.key} className="pa-list-row">
                    <div className="pa-row-between">
                      <strong>{g.cause.label}</strong>
                      <span className="pa-row">
                        {g.open > 0 && <Badge tone="warn">{g.open} sin resolver</Badge>}
                        <span className="pa-muted">{g.items.length} {g.items.length === 1 ? "reporte" : "reportes"}</span>
                      </span>
                    </div>
                    <div style={{ marginTop: 4 }}>Posible solución: {g.cause.solution}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Balanzas" subtitle={`${detail.scales.filter((s) => s.active).length} activas de ${detail.scales.length} registradas`}>
            {detail.scales.length === 0 ? <p className="pa-muted">No tiene balanzas registradas.</p> : (
              <div className="pa-table-wrap">
                <table className="pa-table">
                  <thead><tr><th>Balanza</th><th>Identidad y etiqueta</th><th>PC y puerto</th><th>Instalación</th><th>Último uso</th></tr></thead>
                  <tbody>
                    {detail.scales.map((s) => (
                      <tr key={`${s.branchName}|${s.scaleKey}`}>
                        <td>
                          <strong>{s.name ?? s.scaleKey}</strong> {!s.active || s.status !== "active" ? <Badge tone="neutral">Inactiva</Badge> : null}
                          <div className="pa-muted" style={{ fontSize: 12 }}>{capital(s.family ?? s.brand)} {s.model ?? ""} · {s.branchName ?? "-"}</div>
                        </td>
                        <td>
                          <div style={{ fontSize: 13 }}>{pairs(s.identity) || <span className="pa-muted">Sin identidad</span>}</div>
                          <div className="pa-muted" style={{ fontSize: 12 }}>{labelSpecText(s.labelSpec)}</div>
                        </td>
                        <td>
                          {s.connectorName ? <>{s.connectorName}<div className="pa-muted" style={{ fontSize: 12 }}>{pairs(s.connectorDevice) || "Puerto sin datos"}</div></> : <span className="pa-muted">Por el navegador (sin Scale Connect)</span>}
                        </td>
                        <td style={{ fontSize: 13 }}>{Object.keys(s.install).length ? installSummary(s.install as InstallRecord).text : <span className="pa-muted">Sin datos</span>}</td>
                        <td>{ago(s.lastUsedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Computadoras con Scale Connect">
            <CompanyChannelSelect companyId={companyId} companyName={name} />
            {detail.connectors.length === 0 ? <p className="pa-muted">No instaló Scale Connect en ninguna PC.</p> : (
              <div className="pa-table-wrap">
                <table className="pa-table">
                  <thead><tr><th>PC</th><th>Estado</th><th>Versión</th><th>Último latido</th><th className="num">Balanzas que ve</th></tr></thead>
                  <tbody>
                    {detail.connectors.map((c) => (
                      <tr key={c.id}>
                        <td><strong>{c.name}</strong><div className="pa-muted" style={{ fontSize: 12 }}>{c.branchName ?? "Sin sucursal"}</div></td>
                        <td>{c.status === "revoked" ? <Badge tone="neutral">Desvinculada {when(c.revokedAt)}</Badge> : c.online ? <Badge tone="ok">En línea</Badge> : <Badge tone="warn">Sin conexión</Badge>}</td>
                        <td>{c.version ? `v${c.version}` : "-"}</td>
                        <td>{ago(c.lastSeenAt)}</td>
                        <td className="num">{c.seenScales}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Últimos envíos" subtitle={detail.jobs.length ? `Los ${detail.jobs.length} más nuevos` : undefined}>
            {detail.jobs.length === 0 ? <p className="pa-muted">Todavía no hay envíos registrados.</p> : (
              <div className="pa-table-wrap" style={{ maxHeight: 420, overflow: "auto" }}>
                <table className="pa-table">
                  <thead><tr><th>Cuándo</th><th>Balanza</th><th>Qué</th><th>Resultado</th><th className="num">Confirmados / pedidos</th><th>Código</th></tr></thead>
                  <tbody>
                    {detail.jobs.map((j) => (
                      <tr key={j.id}>
                        <td>{when(j.startedAt)}</td>
                        <td>{j.scaleName ?? j.scaleKey}<div className="pa-muted" style={{ fontSize: 12 }}>{j.branchName ?? "-"}</div></td>
                        <td>{JOB_KIND[j.kind] ?? j.kind}<div className="pa-muted" style={{ fontSize: 12 }}>{j.connectorName ? `por ${j.connectorName}` : j.source === "web" ? "por el navegador" : j.source}</div></td>
                        <td><Badge tone={JOB_STATUS[j.status]?.tone ?? "neutral"}>{JOB_STATUS[j.status]?.label ?? j.status}</Badge></td>
                        <td className="num">{j.confirmed} / {j.requested}{j.failed ? <div className="pa-text-danger" style={{ fontSize: 12 }}>{j.failed} con problemas</div> : null}</td>
                        <td>{j.errorCode ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Productos que fallan" subtitle="Últimos 30 días, agrupados por producto y motivo">
            {detail.failedProducts.length === 0 ? <p className="pa-muted">Ningún producto falló en los últimos 30 días.</p> : (
              <div className="pa-table-wrap">
                <table className="pa-table">
                  <thead><tr><th>Producto</th><th>Motivo</th><th>Causa</th><th className="num">Veces</th><th>Última vez</th></tr></thead>
                  <tbody>
                    {detail.failedProducts.map((f) => (
                      <tr key={`${f.product}|${f.reason}`}>
                        <td>{f.product}{f.plu ? <div className="pa-muted" style={{ fontSize: 12 }}>PLU {f.plu}</div> : null}</td>
                        <td style={{ fontSize: 13 }}>{f.reason}</td>
                        <td style={{ fontSize: 13 }}>{classifyScaleCause({ message: f.reason }).label}</td>
                        <td className="num">{f.times}</td>
                        <td>{ago(f.lastAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Reportes de soporte" subtitle={detail.reports.length ? `Los ${detail.reports.length} más nuevos` : undefined}>
            {detail.reports.length === 0 ? <p className="pa-muted">No mandó reportes.</p> : (
              <div style={{ display: "grid", gap: 8 }}>
                {detail.reports.map((r) => {
                  const cause = reportCause(r);
                  return (
                    <div key={r.id} className="pa-list-row" style={{ opacity: r.resolvedAt ? 0.7 : 1 }}>
                      <div className="pa-row-between">
                        <span className="pa-row">
                          {r.resolvedAt ? <Badge tone="ok">Resuelto</Badge> : <Badge tone="warn">Sin resolver</Badge>}
                          <strong>{cause.label}</strong>
                          <span className="pa-muted">{when(r.createdAt)} · {r.branchName ?? "Sin sucursal"}{r.userName ? ` · ${r.userName}` : ""}</span>
                        </span>
                        <span className="pa-row">
                          <Button variant="secondary" size="sm" icon={FileText} onClick={() => setLogFor(r)}>Ver registro técnico</Button>
                          <Button variant="secondary" size="sm" loading={busyId === r.id} onClick={() => void toggleResolved(r)}>
                            {r.resolvedAt ? "Marcar sin resolver" : "Marcar resuelto"}
                          </Button>
                        </span>
                      </div>
                      <dl className="pa-dl" style={{ marginTop: 6 }}>
                        <dt>Etapa</dt><dd>{r.stage ?? "-"}</dd>
                        <dt>Mensaje</dt><dd>{r.message ?? r.note ?? "-"}</dd>
                        {r.technical && <><dt>Técnico</dt><dd style={{ wordBreak: "break-word" }}>{r.technical}</dd></>}
                        <dt>Posible solución</dt><dd>{cause.solution}</dd>
                      </dl>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="Lecturas ambiguas">
            <p className="pa-muted">
              {detail.ambiguitiesSupported
                ? detail.ambiguities.length ? `${detail.ambiguities.length} registradas.` : "No hay lecturas ambiguas registradas."
                : "Todavía no se guardan en la base (cuando dos balanzas reclaman el mismo código, se ve solo en la PC del local). Los registros repetidos sí aparecen en el estado de la sucursal."}
            </p>
          </Card>
        </>
      )}

      {logFor && <ReportLogModal report={logFor} onClose={() => setLogFor(null)} />}
    </>
  );
}

function ReportLogModal({ report, onClose }: { report: ScaleDetailReport; onClose: () => void }) {
  const [log, setLog] = useState<ScaleReportLog | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchScaleReportLog(report.id)
      .then((l) => { if (alive) setLog(l); })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : "No se pudo leer el registro."); });
    return () => { alive = false; };
  }, [report.id]);

  // La base ya lo limpió; se vuelve a limpiar acá por las dudas (scale-center.ts).
  const parsed = useMemo(() => (log ? parseReportLog(log.logText) : null), [log]);
  const connections = useMemo(() => (log ? redactSensitive(JSON.stringify(log.connections, null, 2)) : ""), [log]);
  const cause = parsed ? classifyScaleCause({ stage: parsed.stage, message: parsed.message, technical: parsed.technical, note: log?.note ?? null }) : null;

  const fullText = log && parsed
    ? [
        `Cliente: ${log.companyName}${log.branchName ? ` · ${log.branchName}` : ""}`,
        `Fecha: ${when(log.createdAt)}`,
        `Nota: ${redactSensitive(log.note) || "-"}`,
        cause ? `Causa probable: ${cause.label} — ${cause.solution}` : "",
        `Navegador: ${log.userAgent ?? "-"}`,
        `Balanzas configuradas: ${connections}`,
        "Registro técnico:",
        parsed.pretty
      ].filter(Boolean).join("\n")
    : "";

  return (
    <Modal
      open
      size="lg"
      title="Registro técnico"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cerrar</Button>
          <Button icon={Copy} disabled={!fullText} onClick={() => { void navigator.clipboard.writeText(fullText); setCopied(true); }}>{copied ? "¡Copiado!" : "Copiar"}</Button>
        </>
      }
    >
      {error && <Alert tone="warn">{error}</Alert>}
      {!log && !error && <Skeleton lines={6} />}
      {log && parsed && (
        <div style={{ display: "grid", gap: 10 }}>
          <Alert tone="info">Sin contraseñas, tokens, emails, teléfonos ni importes: se sacan antes de mostrarlo.</Alert>
          <dl className="pa-dl">
            <dt>Cliente</dt><dd>{log.companyName}{log.branchName ? ` · ${log.branchName}` : ""} · {when(log.createdAt)}</dd>
            {cause && <><dt>Causa probable</dt><dd><strong>{cause.label}</strong> — {cause.solution}</dd></>}
            <dt>Etapa</dt><dd>{parsed.stage ?? "-"}</dd>
            <dt>Mensaje</dt><dd>{parsed.message ?? redactSensitive(log.note) ?? "-"}</dd>
            {parsed.technical && <><dt>Técnico</dt><dd style={{ wordBreak: "break-word" }}>{parsed.technical}</dd></>}
            {parsed.cable && <><dt>Cable</dt><dd style={{ wordBreak: "break-word" }}>{parsed.cable}</dd></>}
            {parsed.version && <><dt>Versión de la web</dt><dd>{parsed.version}</dd></>}
          </dl>
          {parsed.steps.length > 0 && (
            <div>
              <strong>Pasos</strong>
              <ol style={{ margin: "4px 0 0", paddingLeft: 20 }}>{parsed.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </div>
          )}
          <pre className="pa-pre">{parsed.pretty}</pre>
        </div>
      )}
    </Modal>
  );
}
