import { useMemo, useRef, useState } from "react";
import { takeSystelBackup, backupToJson, saveBackupLocally, type SystelBackup } from "./systel-backup";
import { SystelClient } from "./systel-client";
import { buildCuoraNeoCsv, buildQendraCsv, type SystelCsvProduct } from "./systel-csv";
import { SYSTEL_MODELS, systelCanWriteProducts, type SystelModelId } from "./systel-models";
import { LAYOUT_INFO, rawToPesos } from "./systel-plu";
import { CUORA_SERIAL, pickSystelPort, SerialSystelLink } from "./systel-serial";
import { planSystelSync, runSystelSync, type SystelPlanItem, type SystelSyncResult } from "./systel-sync";
import { runSystelWriteTest, type SystelWriteTestResult } from "./systel-write-test";
import { submitScaleSupportReport } from "../../scales/support-service";
import { logScaleActivity } from "../../scales/activity-log";
import { useAuth } from "../../auth/AuthProvider";
import { useActiveBranch } from "../../branches/BranchProvider";

/**
 * "Balanza Systel": módulo aparte del de Kretz. Conectar → respaldo (solo lectura)
 * → vista previa de lo que se mandaría → prueba controlada → envío.
 * El envío real queda bloqueado hasta que el modelo tenga evidencia "real"
 * (systel-models.ts), es decir, hasta que la prueba controlada salga bien en una balanza de verdad.
 */

export interface SystelPanelProduct {
  code: string;
  name: string;
  unit: string;
  priceRetail: number;
  active?: boolean;
}

function download(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const ACTION_LABEL: Record<SystelPlanItem["action"], string> = {
  actualizar: "Cambia el precio",
  crear: "Se crea",
  sin_cambios: "Ya está igual",
  revisar: "Revisar (no se toca)",
  omitir: "No se manda"
};

/**
 * `pilot`: un solo botón "Mandar productos a la balanza" (lee y respalda → plan → manda, primero
 * los nuevos, relee cada uno y frena ante cualquier diferencia → resultado a soporte). Pedido del
 * dueño 2026-10-09: al cliente se le pide UNA sola acción. Sin marcas a la vista.
 */
export function SystelPanel({ products, pilot = false }: { products: SystelPanelProduct[]; pilot?: boolean }) {
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState<SystelModelId>("cuora_max");
  const [address, setAddress] = useState(1);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [backup, setBackup] = useState<SystelBackup | null>(null);
  const [test, setTest] = useState<SystelWriteTestResult | null>(null);
  const [sync, setSync] = useState<SystelSyncResult | null>(null);
  const linkRef = useRef<SerialSystelLink | null>(null);
  const model = SYSTEL_MODELS.find((m) => m.id === modelId)!;
  const { profile } = useAuth();
  const { branchId } = useActiveBranch();
  const [reportNote, setReportNote] = useState("");

  /**
   * Cada paso (respaldo, prueba, envío o error) le llega solo a soporte, con todo lo que se
   * leyó y se mandó: así no hay que pedirle fotos al cliente (regla del dueño).
   * Solo dueño o administrador pueden mandar reportes (submit_scale_support_report, migración 100).
   */
  async function autoReport(step: string, detail: string, extra: { backup?: SystelBackup | null; test?: SystelWriteTestResult | null; sync?: SystelSyncResult | null; error?: string } = {}) {
    logScaleActivity({ kind: extra.error ? "error" : "test", connectionLabel: `Systel ${modelId}`, message: `${step}: ${detail}` });
    if (profile?.role !== "owner" && profile?.role !== "admin") return;
    try {
      await submitScaleSupportReport({
        note: `Systel (${modelId}, dirección ${address}) · ${step}: ${detail}`,
        logText: `${step}: ${detail}${extra.error ? `\nError: ${extra.error}` : ""}`,
        connections: [
          {
            displayName: "Systel (panel)",
            driverId: `systel-${modelId}`,
            status: linkRef.current ? "conectada" : "sin conectar",
            settings: { modelId, address },
            confirmedCapabilities: [],
            pairedAt: "",
            connectedNow: Boolean(linkRef.current),
            pluScan: extra.backup ?? backup ?? undefined,
            auraWriteTest: extra.test ?? test ?? undefined,
            diagnosticRecord: { sync: extra.sync ?? sync ?? null, error: extra.error ?? null }
          }
        ],
        branchId: branchId ?? null
      });
      setReportNote("El resultado ya le llegó al equipo de Patagonia OS.");
    } catch {
      setReportNote("No se pudo mandar el resultado a soporte: sacale una foto a esta pantalla.");
    }
  }

  const active = useMemo(() => products.filter((p) => p.active ?? true), [products]);
  const csvProducts: SystelCsvProduct[] = useMemo(() => active.map((p) => ({ code: p.code, name: p.name, byWeight: p.unit === "kg", price: p.priceRetail })), [active]);
  const plan = useMemo(() => (backup ? planSystelSync(backup, csvProducts) : []), [backup, csvProducts]);
  const toSend = plan.filter((p) => p.action === "actualizar" || p.action === "crear");

  async function withClient<T>(fn: (client: SystelClient) => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError("");
    try {
      if (!linkRef.current) {
        const port = await pickSystelPort();
        linkRef.current = new SerialSystelLink(port, CUORA_SERIAL);
        await linkRef.current.connect();
      }
      return await fn(new SystelClient(linkRef.current, { address }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      void autoReport("error", message, { error: message });
      return null;
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  async function changePort() {
    await linkRef.current?.close();
    linkRef.current = null;
    setBackup(null);
  }

  async function handleBackup() {
    const b = await withClient((c) => takeSystelBackup(c, setProgress));
    if (b) {
      setBackup(b);
      saveBackupLocally(b);
      void autoReport("respaldo (solo lectura)", `${b.detail} · ${b.plus.length} productos leídos`, { backup: b });
    }
  }

  async function handleTest() {
    if (!window.confirm("La prueba crea 2 productos de prueba en números de PLU libres y le cambia el precio a uno. No borra ni cambia tus productos. ¿Seguir?")) return;
    const r = await withClient((c) => runSystelWriteTest(c, setProgress));
    if (r) {
      setTest(r);
      if (r.backup) setBackup(r.backup);
      void autoReport("prueba controlada", `${r.verdict}: ${r.detail}`, { test: r, backup: r.backup });
    }
  }

  async function handleSend() {
    if (!backup?.layout || !systelCanWriteProducts(model)) return;
    if (!window.confirm(`Se van a mandar ${toSend.length} productos a la balanza. No se borra nada. ¿Seguir?`)) return;
    const layout = backup.layout;
    const r = await withClient((c) => runSystelSync(c, layout, plan, setProgress));
    if (r) {
      setSync(r);
      void autoReport("envío de productos", r.stoppedAt ? "se frenó" : "terminó", { sync: r });
    }
  }

  const decimals = backup?.signature?.priceDecimals ?? 0;

  async function handleOneClick() {
    const result = await withClient(async (c) => {
      setProgress("Leyendo lo que tiene la balanza (no cambia nada)…");
      const b = await takeSystelBackup(c, setProgress);
      setBackup(b);
      saveBackupLocally(b);
      if (!b.complete || !b.layout) return { b, p: [] as SystelPlanItem[], r: null as SystelSyncResult | null };
      const p = planSystelSync(b, csvProducts);
      const r = await runSystelSync(c, b.layout, p, setProgress);
      return { b, p, r };
    });
    if (!result) return;
    setSync(result.r);
    const sent = result.r?.done.length ?? 0;
    const skipped = result.p.filter((x) => x.action === "revisar" || x.action === "omitir").length;
    const detail = !result.r
      ? `no se pudo leer la balanza completa: ${result.b.detail}`
      : result.r.stoppedAt
        ? `se frenó en el PLU ${result.r.stoppedAt.number}: ${result.r.stoppedAt.outcome.detail} (${sent} ya mandados)`
        : `${sent} mandados, ${skipped} sin tocar, ${result.b.plus.length} productos leídos de la balanza`;
    void autoReport("mandar productos (un botón)", detail, { backup: result.b, sync: result.r });
  }

  if (pilot) {
    const done = sync?.done ?? [];
    const created = done.filter((d) => d.action === "crear").length;
    const updated = done.filter((d) => d.action === "actualizar").length;
    const untouched = plan.filter((p) => p.action === "revisar" || p.action === "omitir");
    return (
      <>
        <button className="secondary" onClick={() => setOpen((v) => !v)}>{open ? "Ocultar balanza" : "Balanza"}</button>
        {open && (
          <div className="panel" style={{ width: "100%", marginTop: 12, display: "grid", gap: 10 }}>
            <div>
              <p style={{ margin: "0 0 2px", fontWeight: 700, fontSize: 16 }}>Balanza</p>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>Con la balanza conectada por USB, manda tus productos y precios. No borra nada de la balanza.</p>
            </div>
            <div>
              <button disabled={busy} onClick={() => void handleOneClick()}>{busy ? "Mandando…" : "Mandar productos a la balanza"}</button>
              <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>La primera vez, Chrome pregunta qué puerto usar: elegí el que dice USB y tocá Conectar.</p>
            </div>
            {progress && <p className="muted" style={{ margin: 0 }}>{progress}</p>}
            {error && <p className="message warning" style={{ margin: 0 }}>No se pudo: {error}. No se cambió nada en la balanza.</p>}
            {backup && !sync && !busy && !error && <p className="message warning" style={{ margin: 0 }}>Se leyó la balanza pero no se mandó nada: {backup.detail}</p>}
            {sync && (
              <p className={sync.stoppedAt ? "message warning" : "message"} style={{ margin: 0 }}>
                {sync.stoppedAt
                  ? `Se frenó para no arriesgar nada (${sync.stoppedAt.outcome.detail}). Se mandaron bien ${done.length}. No se borró nada.`
                  : `✅ Listo: ${created} productos nuevos y ${updated} precios actualizados en la balanza.${untouched.length ? ` ${untouched.length} quedaron como estaban (ver detalle).` : ""}`}
              </p>
            )}
            {reportNote && <p className="muted" style={{ margin: 0, fontSize: 12 }}>{reportNote}</p>}
            {plan.length > 0 && (
              <details>
                <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 700 }}>Ver detalle por producto</summary>
                <div style={{ maxHeight: 300, overflowY: "auto", marginTop: 6 }}>
                  <table className="data-table">
                    <thead><tr><th>N.º</th><th>Producto</th><th>Qué pasó</th><th>Detalle</th></tr></thead>
                    <tbody>
                      {plan.map((p, i) => (
                        <tr key={i}><td>{p.number ?? "-"}</td><td>{p.name}</td><td>{ACTION_LABEL[p.action]}</td><td className="muted" style={{ fontSize: 12 }}>{p.reason}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "#47505c" }}>Opciones</summary>
              <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                <label style={{ fontSize: 13 }}>
                  Número de balanza{" "}
                  <input type="number" min={1} max={99} value={address} onChange={(e) => setAddress(Number(e.target.value) || 1)} style={{ width: 70 }} disabled={busy} />
                  <span className="muted" style={{ fontSize: 12 }}> (de fábrica es 1)</span>
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {linkRef.current && <button className="secondary" disabled={busy} onClick={changePort}>Elegir otro puerto</button>}
                  {backup && <button className="secondary" onClick={() => download(`respaldo_balanza_${backup.takenAt.slice(0, 10)}.json`, backupToJson(backup), "application/json")}>Descargar copia de la balanza</button>}
                  <button className="secondary" onClick={() => download("productos_qendra.csv", buildQendraCsv(csvProducts).csv, "text/csv")}>Archivo para el programa de la balanza (Qendra)</button>
                </div>
              </div>
            </details>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <button className="secondary" onClick={() => setOpen((v) => !v)}>
        {open ? "Ocultar balanza Systel" : "Balanza Systel"}
      </button>
      {open && (
        <div className="panel" style={{ width: "100%", marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>Balanza Systel</h3>
          <label>
            Modelo{" "}
            <select value={modelId} onChange={(e) => { setModelId(e.target.value as SystelModelId); setBackup(null); setTest(null); setSync(null); }} disabled={busy}>
              {SYSTEL_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
          <p className="muted" style={{ fontSize: 13 }}>{model.notes} Conexión: {model.connection}</p>

          {model.products === "cable" && (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <label>
                  Número de balanza{" "}
                  <input type="number" min={1} max={99} value={address} onChange={(e) => setAddress(Number(e.target.value) || 1)} style={{ width: 70 }} disabled={busy} />
                </label>
                <span className="muted" style={{ fontSize: 12 }}>(en la balanza: Menú → 11 Configurar equipo → 3 Conectividad → 1 Identificación)</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                <button disabled={busy} onClick={handleBackup}>1. Leer la balanza y hacer el respaldo</button>
                {linkRef.current && <button className="secondary" disabled={busy} onClick={changePort}>Elegir otro puerto</button>}
                {backup && <button className="secondary" onClick={() => download(`respaldo_systel_${backup.takenAt.slice(0, 10)}.json`, backupToJson(backup), "application/json")}>Descargar respaldo</button>}
              </div>
              {progress && <p className="muted">{progress}</p>}
              {error && <p className="error">{error}</p>}
              {reportNote && <p className="muted" style={{ fontSize: 12 }}>{reportNote}</p>}

              {backup && (
                <div style={{ marginTop: 12, fontSize: 14 }}>
                  <p style={{ margin: "4px 0" }}>
                    {backup.layout ? LAYOUT_INFO[backup.layout].label : "Formato no reconocido"}
                    {backup.signature && ` · capacidad ${backup.signature.capacityGrams / 1000} kg · hasta ${backup.signature.pluCapacity} productos · precio ${decimals === 2 ? "con centavos (máximo $9.999,99)" : "sin centavos (máximo $999.999)"}`}
                  </p>
                  <p style={{ margin: "4px 0" }} className={backup.complete ? "" : "error"}>{backup.detail}</p>
                </div>
              )}

              {backup?.layout && (
                <>
                  <h4>2. Prueba controlada (una sola vez por modelo)</h4>
                  <p className="muted" style={{ fontSize: 13 }}>Crea 2 productos de prueba en números libres (uno por kilo y uno por unidad), los relee, le cambia el precio a uno y comprueba que tus productos sigan idénticos al respaldo. Si algo no coincide, frena.</p>
                  <button disabled={busy} onClick={handleTest}>Hacer la prueba controlada</button>
                  {test && (
                    <div style={{ marginTop: 8 }}>
                      <p className={test.verdict === "ok" ? "success" : "error"}><strong>{test.verdict === "ok" ? "Salió bien" : "Se frenó"}:</strong> {test.detail}</p>
                      <ul style={{ fontSize: 13 }}>
                        {test.steps.map((s, i) => (
                          <li key={i}>{s.ok ? "✔" : "✖"} {s.label}: {s.detail}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <h4>3. Productos a mandar</h4>
                  <table style={{ fontSize: 13, width: "100%" }}>
                    <thead>
                      <tr><th align="left">PLU</th><th align="left">Producto</th><th align="left">Qué pasa</th><th align="left">Detalle</th></tr>
                    </thead>
                    <tbody>
                      {plan.map((p, i) => (
                        <tr key={i}>
                          <td>{p.number ?? "—"}</td>
                          <td>{p.name}</td>
                          <td>{ACTION_LABEL[p.action]}</td>
                          <td className="muted">{p.reason}{p.action === "crear" && p.priceRaw !== null ? ` · $${rawToPesos(p.priceRaw, decimals)}` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ marginTop: 10 }}>
                    <button disabled={busy || !toSend.length || !systelCanWriteProducts(model)} onClick={handleSend}>
                      Mandar {toSend.length} productos
                    </button>
                    {!systelCanWriteProducts(model) && <p className="muted" style={{ fontSize: 12 }}>El envío se habilita cuando este modelo pase la prueba controlada en una balanza real.</p>}
                  </div>
                  {sync && (
                    <p className={sync.stoppedAt ? "error" : "success"}>
                      {sync.stoppedAt ? `Se frenó en el PLU ${sync.stoppedAt.number}: ${sync.stoppedAt.outcome.detail}. Confirmados: ${sync.done.length}.` : `Listo: ${sync.done.length} productos confirmados uno por uno.`}
                    </p>
                  )}
                </>
              )}
            </>
          )}

          {(model.id === "cuora_max" || model.id === "cuora_2") && (
            <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>
              ¿Usás Qendra?{" "}
              <button className="secondary" onClick={() => download("productos_qendra.csv", buildQendraCsv(csvProducts).csv, "text/csv")}>Descargar archivo para Qendra</button>{" "}
              En Qendra, dejá apagada la opción de borrar los productos que no estén en el archivo.
            </p>
          )}
          {model.products === "archivo_ftp" && (
            <p style={{ fontSize: 13 }}>
              <button className="secondary" onClick={() => download("productos_cuora_neo.csv", buildCuoraNeoCsv(csvProducts).csv, "text/csv")}>Descargar archivo para la Cuora Neo</button>{" "}
              La balanza lo importa desde un servidor FTP/SFTP (Configuración → Importación).
            </p>
          )}
          {model.products === "no" && <p style={{ fontSize: 13 }}>Estas balanzas no guardan productos de la PC: solo se puede leer el peso.</p>}
        </div>
      )}
    </>
  );
}
