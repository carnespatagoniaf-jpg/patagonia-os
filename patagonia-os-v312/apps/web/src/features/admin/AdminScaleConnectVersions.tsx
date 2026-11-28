// Bloque "Versiones de Scale Connect" de la pestaña Balanzas del panel de plataforma (migraciones 229 y 231):
// qué versiones están publicadas, cuántas PC tiene cada una, y Subir porcentaje / Frenar / Pasar a estable.
// Escribe solo con las RPC de la 229. El selector de canal de cada cliente está en el detalle (CompanyChannelSelect).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import {
  CHANNEL_LABEL,
  channelMessage,
  mergeVersionStats,
  nextRolloutSteps,
  parseRolloutPercent,
  promoteBlocker,
  promoteReleaseMessage,
  releaseStateText,
  rolloutMessage,
  stopReleaseMessage,
  type ReleaseChannel,
  type ReleaseRow,
  type VersionStats
} from "./scale-connect-versions";
import {
  fetchCompanyChannel,
  fetchInstalledVersions,
  fetchReleaseManifest,
  fetchReleases,
  publishToStable,
  setCompanyChannel,
  setReleaseRollout
} from "./scale-connect-versions-service";
import { Alert, Badge, Button, Card, Select, Skeleton, useConfirm } from "./ui/components";

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("es-AR", { hourCycle: "h23", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-");

export function AdminScaleConnectVersions() {
  const [stats, setStats] = useState<VersionStats | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, confirmDialog, askText] = useConfirm();

  const load = useCallback(async () => {
    try {
      const [releases, installed] = await Promise.all([fetchReleases(), fetchInstalledVersions()]);
      if (releases === null) {
        setMissing(true);
        setStats(mergeVersionStats([], installed));
      } else {
        setMissing(false);
        setStats(mergeVersionStats(releases, installed));
      }
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las versiones.");
      setStats((s) => s ?? mergeVersionStats([], []));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo hacer el cambio.");
    } finally {
      setBusy(null);
    }
  }

  async function raise(r: ReleaseRow) {
    const steps = nextRolloutSteps(r.rolloutPercent);
    const text = await askText({
      title: `Subir porcentaje de la v${r.version}`,
      message: `Hoy está al ${r.rolloutPercent} %. Elegí un escalón o escribí un número de 0 a 100.`,
      confirmLabel: "Seguir",
      input: { label: "Porcentaje", defaultValue: String(steps[0] ?? 100), suggestions: steps.map(String) }
    });
    if (text === null) return;
    const next = parseRolloutPercent(text);
    if (next === null) { setError("El porcentaje tiene que ser un número entero de 0 a 100."); return; }
    if (next === r.rolloutPercent) return;
    if (!(await ask({ title: `¿${next} % para la v${r.version}?`, message: rolloutMessage(r, next), confirmLabel: `Pasar a ${next} %` }))) return;
    await act(r.id, () => setReleaseRollout(r.id, true, next));
  }

  async function stop(r: ReleaseRow) {
    if (!(await ask({ title: `¿Frenar la v${r.version}?`, message: stopReleaseMessage(r), confirmLabel: "Frenar", danger: true }))) return;
    await act(r.id, () => setReleaseRollout(r.id, false, null));
  }

  async function promote(r: ReleaseRow) {
    setBusy(r.id);
    let manifest: Record<string, unknown>;
    try {
      manifest = await fetchReleaseManifest(r.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo leer el manifiesto.");
      setBusy(null);
      return;
    }
    setBusy(null);
    const blocker = promoteBlocker(r, typeof manifest.channel === "string" ? manifest.channel : null);
    if (blocker) { setError(blocker); return; }
    if (!(await ask({ title: `¿Pasar la v${r.version} a estable?`, message: promoteReleaseMessage(r), confirmLabel: "Pasar a estable" }))) return;
    await act(r.id, () => publishToStable(manifest));
  }

  return (
    <Card
      title={<span className="pa-row"><Download size={16} aria-hidden /> Versiones de Scale Connect</span>}
      subtitle={stats ? `${stats.totalPcs} PC con Scale Connect activas` : undefined}
      actions={<Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => void load()}>Actualizar</Button>}
    >
      {missing && <Alert tone="info" title="La base todavía no tiene el actualizador">Falta aplicar la migración 229 para publicar y frenar versiones.</Alert>}
      {error && <Alert tone="warn" onClose={() => setError("")}>{error}</Alert>}
      {stats && !stats.detailed && !missing && <Alert tone="info">Falta la migración 231: no se ven las PC en línea ni las actualizaciones que fallaron.</Alert>}
      {!stats ? <Skeleton lines={3} /> : (
        <>
          {stats.releases.length === 0 && !missing ? <p className="pa-muted">Todavía no se publicó ninguna versión.</p> : stats.releases.length > 0 && (
            <div className="pa-table-wrap">
              <table className="pa-table">
                <thead>
                  <tr>
                    <th>Versión</th>
                    <th>Canal</th>
                    <th>Estado</th>
                    <th className="num">PC con esta versión</th>
                    <th className="num">Fallaron</th>
                    <th className="num">Volvieron atrás</th>
                    <th>Publicada</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.releases.map((r) => (
                    <tr key={r.id}>
                      <td><strong>v{r.version}</strong>{r.minVersion ? <div className="pa-muted" style={{ fontSize: 12 }}>desde v{r.minVersion}</div> : null}</td>
                      <td><Badge tone={r.channel === "pilot" ? "info" : "brand"}>{CHANNEL_LABEL[r.channel]}</Badge></td>
                      <td><Badge tone={r.active ? (r.rolloutPercent > 0 ? "ok" : "neutral") : "danger"}>{releaseStateText(r)}</Badge></td>
                      <td className="num">{r.installed}{stats.detailed && r.installed > 0 ? <div className="pa-muted" style={{ fontSize: 12 }}>{r.online} en línea</div> : null}</td>
                      <td className="num">{stats.detailed ? (r.failed ? <strong className="pa-text-warn">{r.failed}</strong> : "-") : "?"}</td>
                      <td className="num">{r.rolledBack ? <strong className="pa-text-danger">{r.rolledBack}</strong> : "-"}</td>
                      <td>{when(r.publishedAt)}</td>
                      <td>
                        <span className="pa-row">
                          {r.active && r.rolloutPercent < 100 && <Button size="sm" variant="secondary" loading={busy === r.id} onClick={() => void raise(r)}>Subir porcentaje</Button>}
                          {r.active && <Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => void stop(r)}>Frenar</Button>}
                          {r.channel === "pilot" && !r.hasStable && r.active && <Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => void promote(r)}>Pasar a estable</Button>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {stats.unpublished.length > 0 && (
            <p className="pa-muted" style={{ fontSize: 13, marginTop: 8 }}>
              Otras versiones instaladas (no publicadas): {stats.unpublished.map((s) => `v${s.version} en ${s.installed} PC`).join(" · ")}
            </p>
          )}
          <p className="pa-muted" style={{ fontSize: 12, marginTop: 8 }}>
            "Fallaron" y "Volvieron atrás" es lo último que informó cada PC al intentar actualizarse a esa versión.
          </p>
        </>
      )}
      {confirmDialog}
    </Card>
  );
}

/** Canal de la empresa (piloto / estable), en el detalle del cliente. Se oculta si la base no tiene la 229/231. */
export function CompanyChannelSelect({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [channel, setChannel] = useState<ReleaseChannel | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ask, confirmDialog] = useConfirm();

  useEffect(() => {
    let alive = true;
    fetchCompanyChannel(companyId)
      .then((c) => { if (alive) setChannel(c); })
      .catch((err) => { if (alive) { setChannel(null); setError(err instanceof Error ? err.message : "No se pudo leer el canal."); } });
    return () => { alive = false; };
  }, [companyId]);

  const options = useMemo(() => (["stable", "pilot"] as ReleaseChannel[]), []);

  async function change(next: ReleaseChannel) {
    if (!channel || next === channel) return;
    if (!(await ask({ title: `¿Pasar a ${CHANNEL_LABEL[next].toLowerCase()}?`, message: channelMessage(companyName, next), confirmLabel: `Pasar a ${CHANNEL_LABEL[next].toLowerCase()}` }))) return;
    setBusy(true);
    try {
      await setCompanyChannel(companyId, next);
      setChannel(next);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el canal.");
    } finally {
      setBusy(false);
    }
  }

  if (channel === undefined) return <Skeleton lines={1} />;
  if (channel === null && !error) return null;
  return (
    <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
      {error && <Alert tone="warn" onClose={() => setError("")}>{error}</Alert>}
      {channel && (
        <label className="pa-row" style={{ flexWrap: "wrap" }}>
          <span>Canal de actualización</span>
          <Select style={{ width: "auto", minWidth: 140 }} value={channel} disabled={busy} onChange={(e) => void change(e.target.value as ReleaseChannel)} aria-label="Canal de actualización de Scale Connect">
            {options.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
          </Select>
          <span className="pa-muted" style={{ fontSize: 12 }}>{channel === "pilot" ? "Recibe también las versiones piloto." : "Recibe solo las versiones estables."}</span>
        </label>
      )}
      {confirmDialog}
    </div>
  );
}
