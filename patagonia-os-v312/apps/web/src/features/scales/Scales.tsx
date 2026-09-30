import { useEffect, useState } from "react";
import type { Product } from "@patagonia/domain";
import { useActiveBranch } from "../branches/BranchProvider";
import { listProductsForBranch } from "../inventory/inventory-service";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import {
  clearLiveScalePort,
  detectScaleOnPort,
  getLiveScalePort,
  isScaleManagerSupported,
  listScaleConnections,
  onScalePortDisconnect,
  reconnectSavedConnections,
  releaseDisconnectedPort,
  removeScaleConnection,
  requestNewScalePort,
  saveScaleConnection,
  setLiveScalePort,
  type ScaleConnectionRecord,
  type ScaleDetectionResult
} from "./manager";
import { CAPABILITY_LABELS, STATUS_DESCRIPTIONS, STATUS_LABELS } from "./labels";
import { getDriverById } from "./registry";
import { runScaleDiagnostics, type DiagnosticReport } from "./diagnostics";
import { getSyncSession, runSafeSync, summarizeSyncSession, type SyncSession } from "./sync";
import { clearActivityLog, exportActivityLogText, getActivityLog, logScaleActivity, type ScaleActivityEntry } from "./activity-log";
import type { ScaleWeightReading } from "./types";
import { forgetWeightScale, setWeightScaleEnabled, setWeightScalePort } from "../sale/scale-weight";

/** Balanza de peso guardada acá (con lectura confirmada por el cajero) y
 * enlazada a un puerto en esta sesión -> Mostrador lee de ese puerto. Así
 * se configura en un solo lugar, sin repetirlo en el engranaje de Mostrador. */
function linkWeightScaleToMostrador(): void {
  const weight = listScaleConnections().find((c) => c.confirmedCapabilities.includes("readWeight") && getLiveScalePort(c.id));
  if (!weight) return;
  void setWeightScalePort(getLiveScalePort(weight.id)!);
}

/**
 * Pantalla "Configuración → Balanzas": punto único para conectar cualquier
 * balanza soportada, con la filosofía Conectar → Detectar → Probar →
 * Guardar. Ningún dato técnico (COM, baudios, checksum, protocolo) se
 * muestra fuera de "Configuración avanzada".
 *
 * Convive con los paneles viejos (ScaleWeightSettings en el engranaje de
 * Mostrador, ScaleSyncPanel en Stock) -- no los reemplaza todavía. Los dos
 * siguen funcionando exactamente igual que antes; esta pantalla es la base
 * de la arquitectura nueva (Scale Manager) y a futuro puede llegar a
 * reemplazarlos, pero recién cuando se demuestre en uso real que hace lo
 * mismo o mejor.
 */

type WizardStep =
  | { kind: "connect"; log?: string }
  | { kind: "detecting"; port: SerialPort; log: string }
  | { kind: "not-found"; port: SerialPort; log: string }
  | { kind: "found"; port: SerialPort; detection: ScaleDetectionResult }
  | { kind: "testing-weight"; port: SerialPort; detection: ScaleDetectionResult }
  | { kind: "confirm-weight"; port: SerialPort; detection: ScaleDetectionResult; reading: ScaleWeightReading }
  | { kind: "testing-plu"; port: SerialPort; detection: ScaleDetectionResult }
  | { kind: "ready-to-save"; port: SerialPort; detection: ScaleDetectionResult; confirmedCapabilities: string[]; testMessage: string }
  | { kind: "test-failed"; port: SerialPort; detection: ScaleDetectionResult; message: string };

export function Scales() {
  const { branchId } = useActiveBranch();
  const [connections, setConnections] = useState<ScaleConnectionRecord[]>([]);
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());
  const [wizard, setWizard] = useState<WizardStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [rowMessage, setRowMessage] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowDiagnostics, setRowDiagnostics] = useState<Record<string, DiagnosticReport>>({});
  const [products, setProducts] = useState<Product[]>(isSupabaseConfigured ? [] : demoProducts);
  const [syncSessions, setSyncSessions] = useState<Record<string, SyncSession>>({});
  const [syncProgress, setSyncProgress] = useState<Record<string, { done: number; total: number }>>({});
  const [activityLog, setActivityLog] = useState<ScaleActivityEntry[]>([]);
  const [copyMessage, setCopyMessage] = useState("");

  function refresh() {
    linkWeightScaleToMostrador();
    setConnections(listScaleConnections());
    setLiveIds(new Set(listScaleConnections().filter((c) => getLiveScalePort(c.id)).map((c) => c.id)));
  }

  function log(entry: Omit<ScaleActivityEntry, "at">) {
    logScaleActivity(entry);
    setActivityLog(getActivityLog());
  }

  useEffect(() => {
    refresh();
    setActivityLog(getActivityLog());
    // Intento silencioso de reconectar lo ya guardado -- no pide nada al
    // usuario (getPorts(), no requestPort()), solo vuelve a correr el
    // reconocimiento real de cada driver contra los puertos ya autorizados.
    void reconnectSavedConnections().then(() => refresh());

    // La balanza de precios se enchufa solo para pasar precios: al
    // desenchufarla se marca "No conectada" en el momento, y al volver a
    // enchufarla se la reconoce sola (mismo reconocimiento de siempre).
    const stopDisconnect = onScalePortDisconnect((port) => {
      if (releaseDisconnectedPort(port)) {
        log({ kind: "error", message: "Se desenchufó una balanza." });
        refresh();
      }
    });
    const onConnect = () => void reconnectSavedConnections().then(() => refresh());
    navigator.serial?.addEventListener("connect", onConnect);
    return () => {
      stopDisconnect();
      navigator.serial?.removeEventListener("connect", onConnect);
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || !branchId) return;
    void listProductsForBranch(branchId, false).then(setProducts);
  }, [branchId]);

  useEffect(() => {
    const sessions: Record<string, SyncSession> = {};
    for (const connection of connections) {
      const session = getSyncSession(connection.id);
      if (session) sessions[connection.id] = session;
    }
    setSyncSessions(sessions);
  }, [connections]);

  if (!isScaleManagerSupported()) {
    return (
      <div className="card">
        <h2>Balanzas</h2>
        <p className="muted">Este navegador no soporta la conexión directa con balanzas. Abrí Patagonia OS en Chrome o Edge.</p>
      </div>
    );
  }

  async function startWizard() {
    setWizard({ kind: "connect" });
  }

  async function handleConnect() {
    setBusy(true);
    try {
      const port = await requestNewScalePort();
      setWizard({ kind: "detecting", port, log: "Buscando qué balanza es…" });
      const detection = await detectScaleOnPort(port, (text) => setWizard({ kind: "detecting", port, log: text }));
      if (!detection) {
        setWizard({ kind: "not-found", port, log: "No encontramos la balanza. Revisá que esté encendida y conectada." });
        log({ kind: "detect", message: "No se encontró ninguna balanza conocida en el puerto elegido." });
      } else {
        setWizard({ kind: "found", port, detection });
        log({ kind: "detect", connectionLabel: detection.identify.displayName, message: `Detectada (${detection.driver.status === "certified" ? "certificada" : "experimental"}).` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo conectar con el puerto.";
      setWizard({ kind: "connect", log: message });
      log({ kind: "error", message });
    } finally {
      setBusy(false);
    }
  }

  async function handleRetryDetect(port: SerialPort) {
    setBusy(true);
    try {
      setWizard({ kind: "detecting", port, log: "Buscando qué balanza es…" });
      const detection = await detectScaleOnPort(port, (text) => setWizard({ kind: "detecting", port, log: text }));
      setWizard(
        detection
          ? { kind: "found", port, detection }
          : { kind: "not-found", port, log: "No encontramos la balanza. Revisá que esté encendida y conectada." }
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleTest(port: SerialPort, detection: ScaleDetectionResult) {
    const { driver } = detection;
    setBusy(true);
    try {
      if (driver.capabilities.includes("readWeight") && driver.readWeight) {
        setWizard({ kind: "testing-weight", port, detection });
        const reading = await driver.readWeight(port, detection.identify.settings ?? {});
        setWizard({ kind: "confirm-weight", port, detection, reading });
        log({ kind: "test", connectionLabel: detection.identify.displayName, message: `Lectura de prueba: ${reading.weightKg} kg -- esperando confirmación del cajero.` });
        return;
      }
      if (driver.runCertificationTest) {
        setWizard({ kind: "testing-plu", port, detection });
        const result = await driver.runCertificationTest(port, detection.identify.settings ?? {});
        log({ kind: "certification", connectionLabel: detection.identify.displayName, message: `${result.passed ? "Pasó" : "No pasó"}: ${result.message}` });
        if (result.passed) {
          setWizard({
            kind: "ready-to-save",
            port,
            detection,
            confirmedCapabilities: driver.capabilities.filter((c) => c !== "readWeight"),
            testMessage: result.message
          });
        } else {
          setWizard({ kind: "test-failed", port, detection, message: result.message });
        }
        return;
      }
      // Driver sin ninguna prueba propia todavía (no debería pasar con los
      // drivers actuales) -- no se guarda nada sin haber probado algo real.
      setWizard({ kind: "test-failed", port, detection, message: "Este driver todavía no tiene una prueba automática -- no se puede guardar sin probar." });
    } catch (err) {
      setWizard({ kind: "test-failed", port, detection, message: err instanceof Error ? err.message : "Falló la prueba." });
    } finally {
      setBusy(false);
    }
  }

  function handleWeightConfirmed(port: SerialPort, detection: ScaleDetectionResult, matches: boolean) {
    if (matches) {
      setWizard({ kind: "ready-to-save", port, detection, confirmedCapabilities: ["readWeight"], testMessage: "Confirmado por el cajero: el peso leído coincide con la pantalla de la balanza. Al guardar, Mostrador empieza a tomar el peso de esta balanza (no hace falta configurarla también en el engranaje)." });
    } else {
      setWizard({ kind: "test-failed", port, detection, message: "El peso leído no coincide con la pantalla de la balanza -- no se activó. Mandá una captura de esta pantalla al equipo de Patagonia OS." });
    }
  }

  function handleSave(port: SerialPort, detection: ScaleDetectionResult, confirmedCapabilities: string[]) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    saveScaleConnection({
      id,
      driverId: detection.driver.id,
      displayName: detection.identify.displayName ?? `${detection.driver.brand} ${detection.driver.models[0] ?? ""}`.trim(),
      status: detection.driver.status,
      settings: detection.identify.settings ?? {},
      confirmedCapabilities,
      pairedAt: now,
      lastVerifiedAt: now
    });
    setLiveScalePort(id, port);
    if (confirmedCapabilities.includes("readWeight")) {
      // Mismo efecto que "Sí, coincide" en el engranaje de Mostrador: el
      // cajero ya comparó la lectura con la pantalla de la balanza.
      setWeightScaleEnabled(true);
      void setWeightScalePort(port);
    }
    setWizard(null);
    refresh();
  }

  async function handleRowTest(connection: ScaleConnectionRecord) {
    setRowBusy((s) => ({ ...s, [connection.id]: true }));
    setRowMessage((s) => ({ ...s, [connection.id]: "" }));
    try {
      let port = getLiveScalePort(connection.id);
      if (!port) {
        await reconnectSavedConnections();
        port = getLiveScalePort(connection.id);
      }
      if (!port) {
        setRowMessage((s) => ({ ...s, [connection.id]: "No está conectada ahora mismo. Conectá el cable y tocá \"Probar\" de nuevo." }));
        return;
      }
      const driver = detectDriverFor(connection);
      if (!driver) {
        setRowMessage((s) => ({ ...s, [connection.id]: "No encontramos el driver de esta balanza (¿versión vieja de la app?)." }));
        return;
      }
      if (driver.capabilities.includes("readWeight") && driver.readWeight) {
        const reading = await driver.readWeight(port, connection.settings);
        setRowMessage((s) => ({ ...s, [connection.id]: `Leí ${reading.weightKg.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg. Si no coincide con la pantalla de la balanza, avisá antes de usarla para cobrar.` }));
        return;
      }
      if (driver.runCertificationTest) {
        const result = await driver.runCertificationTest(port, connection.settings);
        setRowMessage((s) => ({ ...s, [connection.id]: `${result.passed ? "✓" : "✗"} ${result.message}` }));
        return;
      }
      setRowMessage((s) => ({ ...s, [connection.id]: "Esta balanza no tiene una prueba automática todavía." }));
    } catch (err) {
      setRowMessage((s) => ({ ...s, [connection.id]: err instanceof Error ? err.message : "Falló la prueba." }));
    } finally {
      setRowBusy((s) => ({ ...s, [connection.id]: false }));
    }
  }

  async function handleRowDiagnose(connection: ScaleConnectionRecord) {
    setRowBusy((s) => ({ ...s, [connection.id]: true }));
    setRowMessage((s) => ({ ...s, [connection.id]: "" }));
    setRowDiagnostics((s) => ({ ...s, [connection.id]: undefined as unknown as DiagnosticReport }));
    try {
      let port = getLiveScalePort(connection.id);
      if (!port) {
        await reconnectSavedConnections();
        port = getLiveScalePort(connection.id);
      }
      if (!port) {
        setRowMessage((s) => ({ ...s, [connection.id]: "No está conectada ahora mismo. Conectá el cable y tocá \"Diagnosticar\" de nuevo." }));
        return;
      }
      const driver = detectDriverFor(connection);
      if (!driver) {
        setRowMessage((s) => ({ ...s, [connection.id]: "No encontramos el driver de esta balanza." }));
        return;
      }
      const report = await runScaleDiagnostics(driver, port, connection.settings);
      setRowDiagnostics((s) => ({ ...s, [connection.id]: report }));
      log({ kind: "diagnose", connectionLabel: connection.displayName, message: report.summary });
    } finally {
      setRowBusy((s) => ({ ...s, [connection.id]: false }));
    }
  }

  async function handleRowSync(connection: ScaleConnectionRecord) {
    setRowBusy((s) => ({ ...s, [connection.id]: true }));
    setRowMessage((s) => ({ ...s, [connection.id]: "" }));
    setSyncProgress((s) => ({ ...s, [connection.id]: { done: 0, total: 0 } }));
    try {
      let port = getLiveScalePort(connection.id);
      if (!port) {
        await reconnectSavedConnections();
        port = getLiveScalePort(connection.id);
      }
      if (!port) {
        setRowMessage((s) => ({ ...s, [connection.id]: "No está conectada ahora mismo. Conectá el cable y volvé a tocar \"Sincronizar\"." }));
        return;
      }
      const driver = detectDriverFor(connection);
      if (!driver) {
        setRowMessage((s) => ({ ...s, [connection.id]: "No encontramos el driver de esta balanza." }));
        return;
      }
      const activeProducts = products.filter((p) => p.active ?? true);
      const session = await runSafeSync(driver, port, connection.settings, connection.id, activeProducts, (done, total) =>
        setSyncProgress((s) => ({ ...s, [connection.id]: { done, total } }))
      );
      setSyncSessions((s) => ({ ...s, [connection.id]: session }));
      const summary = summarizeSyncSession(session);
      setRowMessage((s) => ({
        ...s,
        [connection.id]: `${summary.confirmed} confirmados, ${summary.uncertain} sin poder confirmar, ${summary.failed} rechazados, de ${summary.total} productos activos.${
          summary.uncertain + summary.failed > 0 ? " Podés volver a tocar \"Sincronizar\" para reintentar solo los que faltan -- no se reenvía lo que ya está confirmado." : ""
        }`
      }));
      log({ kind: "sync", connectionLabel: connection.displayName, message: `${summary.confirmed}/${summary.total} confirmados, ${summary.uncertain} sin confirmar, ${summary.failed} rechazados.` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falló la sincronización.";
      setRowMessage((s) => ({ ...s, [connection.id]: message }));
      log({ kind: "error", connectionLabel: connection.displayName, message });
    } finally {
      setRowBusy((s) => ({ ...s, [connection.id]: false }));
      setSyncProgress((s) => ({ ...s, [connection.id]: undefined as unknown as { done: number; total: number } }));
    }
  }

  function handleRemove(id: string) {
    if (!window.confirm("¿Quitar esta balanza? Vas a tener que volver a conectarla y detectarla si la necesitás de nuevo.")) return;
    const removed = listScaleConnections().find((c) => c.id === id);
    removeScaleConnection(id);
    clearLiveScalePort(id);
    const otherWeightScale = listScaleConnections().some((c) => c.confirmedCapabilities.includes("readWeight"));
    if (removed?.confirmedCapabilities.includes("readWeight") && !otherWeightScale) {
      setWeightScaleEnabled(false);
      void forgetWeightScale();
    }
    refresh();
  }

  return (
    <div className="card">
      <h2>Balanzas</h2>
      <p className="muted" style={{ marginTop: 4 }}>
        Conectá acá cualquier balanza compatible. Patagonia System la reconoce sola -- no hace falta saber puerto, velocidad ni protocolo.
      </p>

      {connections.length === 0 && !wizard && (
        <p className="muted" style={{ marginTop: 12 }}>Todavía no conectaste ninguna balanza.</p>
      )}

      {connections.map((connection) => (
        <div key={connection.id} style={{ border: "1px solid #eef0f3", borderRadius: 10, padding: 16, marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: 16 }}>{connection.displayName}</p>
            <span className={connection.status === "certified" ? "scale-weight-pill scale-weight-on" : "scale-weight-pill"}>
              {STATUS_LABELS[connection.status]}
            </span>
            <span className={liveIds.has(connection.id) ? "scale-weight-pill scale-weight-on" : "scale-weight-pill"}>
              {liveIds.has(connection.id) ? "Conectada" : "No conectada"}
            </span>
          </div>
          <p className="muted" style={{ margin: "6px 0 10px", fontSize: 13 }}>{STATUS_DESCRIPTIONS[connection.status]}</p>
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
            Funciones: {getDeclaredCapabilityLabels(connection).join(", ") || "ninguna"}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="secondary" disabled={rowBusy[connection.id]} onClick={() => void handleRowTest(connection)}>
              {rowBusy[connection.id] ? "Probando…" : "Probar"}
            </button>
            <button className="secondary" disabled={rowBusy[connection.id]} onClick={() => void handleRowDiagnose(connection)}>
              Diagnosticar
            </button>
            {getDeclaredCapabilityIds(connection).includes("bulkSync") && (
              <button disabled={rowBusy[connection.id]} onClick={() => void handleRowSync(connection)}>
                {syncProgress[connection.id] ? `Sincronizando… ${syncProgress[connection.id].done}/${syncProgress[connection.id].total}` : "Sincronizar catálogo"}
              </button>
            )}
            <button className="secondary" style={{ color: "#8a1f11" }} onClick={() => handleRemove(connection.id)}>
              Quitar
            </button>
            <details style={{ display: "inline-block" }}>
              <summary className="secondary" style={{ display: "inline-block", cursor: "pointer", padding: "10px 14px", border: "1px solid #ccc", borderRadius: 6 }}>
                Configuración avanzada
              </summary>
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 12, whiteSpace: "pre-wrap" }}>
                driver: {connection.driverId}{"\n"}
                ajustes: {JSON.stringify(connection.settings)}{"\n"}
                conectada desde: {new Date(connection.pairedAt).toLocaleString("es-AR")}
              </p>
            </details>
          </div>
          {rowMessage[connection.id] && <p className="message" style={{ marginTop: 10 }}>{rowMessage[connection.id]}</p>}
          {!rowMessage[connection.id] && syncSessions[connection.id] && (
            <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
              Última sincronización: {(() => {
                const summary = summarizeSyncSession(syncSessions[connection.id]);
                return `${summary.confirmed} confirmados, ${summary.uncertain} sin confirmar, ${summary.failed} rechazados, de ${summary.total}`;
              })()} ({new Date(syncSessions[connection.id].updatedAt).toLocaleString("es-AR")})
            </p>
          )}
          {rowDiagnostics[connection.id] && (
            <div className="message" style={{ marginTop: 10 }}>
              <p style={{ margin: "0 0 8px", fontWeight: 700 }}>{rowDiagnostics[connection.id].summary}</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {rowDiagnostics[connection.id].steps.map((step, i) => (
                  <li key={i} style={{ color: step.ok ? "#1a7d3a" : "#8a1f11" }}>
                    {step.ok ? "✓" : "✗"} {step.label}: {step.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}

      {!wizard && (
        <button style={{ marginTop: 16 }} onClick={() => void startWizard()}>
          + Agregar balanza
        </button>
      )}

      {wizard && (
        <div style={{ border: "1px solid #eef0f3", borderRadius: 10, padding: 18, marginTop: 16 }}>
          {wizard.kind === "connect" && (
            <>
              <p style={{ margin: "0 0 10px", fontWeight: 700 }}>1. Conectá tu balanza</p>
              <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>Conectá el cable de la balanza a la PC y tocá el botón. El navegador te va a pedir elegir el puerto.</p>
              <div className="cash-banner-form">
                <button disabled={busy} onClick={() => void handleConnect()}>Conectá tu balanza</button>
                <button className="secondary" disabled={busy} onClick={() => setWizard(null)}>Cancelar</button>
              </div>
              {wizard.log && <p className="message" style={{ marginTop: 12 }}>{wizard.log}</p>}
            </>
          )}

          {wizard.kind === "detecting" && (
            <>
              <p style={{ margin: "0 0 10px", fontWeight: 700 }}>2. Detectando…</p>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>{wizard.log}</p>
            </>
          )}

          {wizard.kind === "not-found" && (
            <>
              <p style={{ margin: "0 0 10px", fontWeight: 700 }}>No encontramos la balanza</p>
              <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>Revisá que esté encendida y bien conectada, y volvé a intentar.</p>
              <div className="cash-banner-form">
                <button disabled={busy} onClick={() => void handleRetryDetect(wizard.port)}>Buscar de nuevo</button>
                <button className="secondary" disabled={busy} onClick={() => setWizard(null)}>Cancelar</button>
              </div>
            </>
          )}

          {wizard.kind === "found" && (
            <>
              <p style={{ margin: "0 0 10px", fontWeight: 700 }}>✓ Balanza encontrada: {wizard.detection.identify.displayName ?? wizard.detection.driver.brand}</p>
              {wizard.detection.driver.status === "experimental" && (
                <p style={{ margin: "0 0 10px", fontSize: 13, color: "#8a4b00" }}>{STATUS_DESCRIPTIONS.experimental}</p>
              )}
              <div className="cash-banner-form">
                <button disabled={busy} onClick={() => void handleTest(wizard.port, wizard.detection)}>Probar</button>
                <button className="secondary" disabled={busy} onClick={() => setWizard(null)}>Cancelar</button>
              </div>
            </>
          )}

          {(wizard.kind === "testing-weight" || wizard.kind === "testing-plu") && (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Probando…</p>
          )}

          {wizard.kind === "confirm-weight" && (
            <>
              <p style={{ margin: "0 0 8px" }}>
                Leí <strong>{wizard.reading.weightKg.toLocaleString("es-AR", { minimumFractionDigits: 3 })} kg</strong>. ¿Es el peso que muestra la pantalla de la balanza?
              </p>
              <div className="cash-banner-form">
                <button onClick={() => handleWeightConfirmed(wizard.port, wizard.detection, true)}>Sí, coincide</button>
                <button className="secondary" onClick={() => handleWeightConfirmed(wizard.port, wizard.detection, false)}>No coincide</button>
              </div>
            </>
          )}

          {wizard.kind === "ready-to-save" && (
            <>
              <p style={{ margin: "0 0 10px", color: "#1a7d3a", fontWeight: 700 }}>✓ Prueba superada</p>
              <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>{wizard.testMessage}</p>
              <div className="cash-banner-form">
                <button onClick={() => handleSave(wizard.port, wizard.detection, wizard.confirmedCapabilities)}>Guardar</button>
                <button className="secondary" onClick={() => setWizard(null)}>Cancelar</button>
              </div>
            </>
          )}

          {wizard.kind === "test-failed" && (
            <>
              <p style={{ margin: "0 0 10px", color: "#8a1f11", fontWeight: 700 }}>✗ La prueba no pasó</p>
              <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>{wizard.message}</p>
              <div className="cash-banner-form">
                <button className="secondary" onClick={() => void handleTest(wizard.port, wizard.detection)}>Probar de nuevo</button>
                <button className="secondary" onClick={() => setWizard(null)}>Cancelar</button>
              </div>
            </>
          )}
        </div>
      )}

      <details style={{ marginTop: 20 }}>
        <summary className="secondary" style={{ display: "inline-block", cursor: "pointer", padding: "10px 14px", border: "1px solid #ccc", borderRadius: 6 }}>
          Actividad reciente (para soporte)
        </summary>
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(exportActivityLogText());
                  setCopyMessage("Copiado -- pegalo en el mensaje a soporte.");
                } catch {
                  setCopyMessage("No se pudo copiar automáticamente -- seleccioná el texto de abajo a mano.");
                }
              }}
            >
              Copiar para soporte
            </button>
            <button
              className="secondary"
              onClick={() => {
                if (!window.confirm("¿Borrar la actividad registrada?")) return;
                clearActivityLog();
                setActivityLog([]);
              }}
            >
              Borrar
            </button>
          </div>
          {copyMessage && <p className="message" style={{ marginBottom: 10 }}>{copyMessage}</p>}
          <pre style={{ maxHeight: 220, overflowY: "auto", background: "#f7f7f8", borderRadius: 6, padding: 10, fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}>
            {activityLog.length === 0
              ? "Sin actividad registrada todavía."
              : [...activityLog].reverse().map((e) => `[${new Date(e.at).toLocaleString("es-AR")}] ${e.kind.toUpperCase()}${e.connectionLabel ? ` (${e.connectionLabel})` : ""}: ${e.message}`).join("\n")}
          </pre>
        </div>
      </details>
    </div>
  );
}

function detectDriverFor(connection: ScaleConnectionRecord) {
  return getDriverById(connection.driverId);
}

function getDeclaredCapabilityLabels(connection: ScaleConnectionRecord): string[] {
  const driver = detectDriverFor(connection);
  return (driver?.capabilities ?? []).map((c) => CAPABILITY_LABELS[c]);
}

function getDeclaredCapabilityIds(connection: ScaleConnectionRecord): string[] {
  return detectDriverFor(connection)?.capabilities ?? [];
}
