import type { Product } from "@patagonia/domain";
import { useEffect, useMemo, useRef, useState } from "react";
import { takeSystelBackup, backupToJson, saveBackupLocally, type SystelBackup } from "./systel-backup";
import { SystelClient } from "./systel-client";
import { buildCuoraNeoCsv, buildQendraCsv, type SystelCsvProduct } from "./systel-csv";
import { SYSTEL_MODELS, systelCanWriteProducts, systelWriteVerified, type SystelModelId } from "./systel-models";
import { LAYOUT_INFO, rawToPesos } from "./systel-plu";
import { CUORA_SERIAL, pickSystelPort, SerialSystelLink } from "./systel-serial";
import { planSystelSync, runSystelSync, type SystelPlanItem, type SystelSyncResult } from "./systel-sync";
import { runSystelWriteTest, type SystelWriteTestResult } from "./systel-write-test";
import { discoverSystelLink, loadSavedSystelLink, saveSystelLink } from "./systel-discovery";
import { enableTicketBarcodes, type TicketBarcodeResult } from "./systel-ticket-barcode";
import { runSystelDiagnostic, type SystelDiagnostic } from "./systel-full-diagnostic";
import { getBranchScaleConfig } from "../../sale/scale-config-service";
import { saveSystelLabelTemplates } from "../../sale/systel-label-format";
import type { SystelExchangeLog } from "./systel-client";
import type { SystelLinkEvent } from "./systel-serial";
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
/**
 * El reporte tiene que llegar aunque la sesión sea larga: si pasa de ~700 KB se recortan primero los
 * eventos del cable y después el registro de órdenes (se conservan los primeros y los últimos).
 */
function boundedDiagnostic<T extends { log: unknown[]; linkEvents: unknown[] }>(d: T): T & { trimmed?: string } {
  const size = () => JSON.stringify(d).length;
  if (size() <= 700_000) return d;
  const keep = <X,>(a: X[], n: number) => (a.length > n ? [...a.slice(0, n / 2), ...a.slice(-n / 2)] : a);
  let out = { ...d, linkEvents: keep(d.linkEvents, 400), trimmed: "eventos del cable recortados" };
  if (JSON.stringify(out).length > 700_000) out = { ...out, log: keep(d.log, 120), trimmed: "eventos y registro recortados" };
  return out;
}

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
  const [ticketResult, setTicketResult] = useState<TicketBarcodeResult | null>(null);
  const [salesDiag, setSalesDiag] = useState<SystelDiagnostic | null>(null);
  const linkRef = useRef<SerialSystelLink | null>(null);
  const model = SYSTEL_MODELS.find((m) => m.id === modelId)!;
  const { profile } = useAuth();
  const { branchId } = useActiveBranch();
  const [reportNote, setReportNote] = useState("");
  const portRef = useRef<SerialPort | null>(null);
  /** Cada pedido y respuesta (bytes en hex), para el reporte a soporte. */
  const logRef = useRef<SystelExchangeLog[]>([]);
  /** Lo que pasó en el cable (abrir, señales, cada byte con su tiempo, lo descartado). */
  const linkEventsRef = useRef<SystelLinkEvent[]>([]);
  const portsRef = useRef<{ authorized: number; picked: string } | null>(null);

  // Al salir de la pantalla se cierra el puerto. Antes quedaba abierto y el intento siguiente fallaba
  // con "The port is already open" (real: Los gringos 2026-10-09 15:59:03).
  useEffect(() => () => {
    void linkRef.current?.close();
    linkRef.current = null;
  }, []);

  // Si se desenchufa el cable, la conexión vieja no sirve más: se suelta para que el próximo toque
  // elija y abra el puerto de nuevo (el objeto SerialPort puede cambiar al volver a enchufar).
  useEffect(() => {
    if (!("serial" in navigator)) return;
    const onDisconnect = (e: Event) => {
      if ((e.target as unknown as SerialPort) !== portRef.current) return;
      linkEventsRef.current.push({ t: -1, kind: "cerrar", detail: "se desenchufó el cable" });
      void linkRef.current?.close();
      linkRef.current = null;
      portRef.current = null;
    };
    navigator.serial.addEventListener("disconnect", onDisconnect);
    return () => navigator.serial.removeEventListener("disconnect", onDisconnect);
  }, []);

  /** Un solo intento a la vez (dos toques seguidos abrían dos conexiones al mismo puerto). */
  const runningRef = useRef(false);

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
            diagnosticRecord: boundedDiagnostic({ sync: extra.sync ?? sync ?? null, error: extra.error ?? null, log: logRef.current.slice(-400), linkEvents: linkEventsRef.current.slice(-1500), ports: portsRef.current, savedLink: loadSavedSystelLink() })
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
      // Escribe solo si la firma + el formato leído están en SYSTEL_VERIFIED_WRITE_PROFILES (hoy vacío).
      return await fn(new SystelClient(linkRef.current, { address, writes: { price: systelWriteVerified("precio", backup?.signature?.protocolVersion, backup?.layout), create: systelWriteVerified("alta", backup?.signature?.protocolVersion, backup?.layout) } }));
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
    portRef.current = null;
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

  /**
   * Botón del piloto: SOLO LEE (decisión del dueño 2026-10-09, envío de precios bloqueado hasta que
   * Systel confirme el E3 y el formato de escritura). Busca la balanza, respalda todo y manda UN
   * reporte con cada byte y su tiempo. No llama a runSystelSync.
   */
  /** Elige el puerto (si hace falta) y busca la balanza. Devuelve su número, o null (ya avisado). */
  async function connectScale(step: string): Promise<number | null> {
    if (!portRef.current) {
      try {
        portRef.current = await pickSystelPort();
      } catch {
        setError("no se eligió el puerto de la balanza");
        return null;
      }
    }
    try {
      const all = await navigator.serial.getPorts();
      const i = portRef.current.getInfo();
      portsRef.current = { authorized: all.length, picked: `${(i.usbVendorId ?? 0).toString(16).padStart(4, "0")}:${(i.usbProductId ?? 0).toString(16).padStart(4, "0")}` };
    } catch {
      portsRef.current = null;
    }
    if (linkRef.current) return address;
    const found = await discoverSystelLink(portRef.current, logRef.current, setProgress, loadSavedSystelLink(), 350, linkEventsRef.current);
    if (!found) {
      const msg = "la balanza no contestó en ninguna configuración";
      setError(msg);
      void autoReport(step, msg, { error: msg });
      portRef.current = null;
      return null;
    }
    linkRef.current = found.link;
    setAddress(found.address);
    saveSystelLink({ settings: found.settings, address: found.address });
    return found.address;
  }

  /**
   * "Activar código por producto en la balanza" (systel-ticket-barcode.ts): una sola orden (función 7),
   * comprobada releyendo la configuración. Sirve para cualquier Systel. El resultado le llega a soporte.
   */
  async function handleTicketBarcodes() {
    if (runningRef.current) return;
    if (!window.confirm("Esto le cambia UNA opción a la balanza: que imprima el código de barras de cada producto en el ticket. No toca productos ni precios. ¿Seguir?")) return;
    runningRef.current = true;
    setBusy(true);
    setError("");
    setReportNote("");
    setTicketResult(null);
    logRef.current = [];
    linkEventsRef.current = [];
    try {
      const runAddress = await connectScale("activar código por producto");
      if (runAddress === null || !linkRef.current) return;
      setProgress("Activando el código por producto en la balanza…");
      const client = new SystelClient(linkRef.current, { address: runAddress, log: logRef.current, writes: { ticketBarcodes: true } });
      const r = await enableTicketBarcodes(client);
      setTicketResult(r);
      void autoReport("activar código por producto", `${r.outcome}: ${r.detail}`, { error: r.ok ? undefined : r.detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      void autoReport("error", message, { error: message });
    } finally {
      runningRef.current = false;
      setBusy(false);
      setProgress("");
    }
  }

  /**
   * Diagnóstico completo, SOLO LECTURA (systel-full-diagnostic.ts): contesta, modelo, reloj, formatos,
   * productos, ventas guardadas, detalle e interpretación. El resultado completo le llega a soporte.
   */
  async function handleSalesDiagnostic() {
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(true);
    setError("");
    setReportNote("");
    setSalesDiag(null);
    logRef.current = [];
    linkEventsRef.current = [];
    try {
      const runAddress = await connectScale("diagnóstico completo");
      if (runAddress === null || !linkRef.current) return;
      const client = new SystelClient(linkRef.current, { address: runAddress, log: logRef.current });
      const branchConfig = branchId ? await getBranchScaleConfig(branchId).catch(() => null) : null;
      // Inventory pasa los productos completos; si alguno no trae id, se usa su código (solo para comparar).
      const asProducts = products.map((p) => ({ ...p, id: (p as { id?: string }).id ?? `codigo-${p.code}` })) as unknown as Product[];
      const r = await runSystelDiagnostic(client, { products: asProducts, branchConfig, onProgress: (t) => setProgress(`${t}… (solo lectura, no cambia nada)`), onConfig: saveSystelLabelTemplates });
      setSalesDiag(r);
      void autoReport("diagnóstico completo (solo lectura)", `${r.verdict}
${JSON.stringify({ pasos: r.steps, datos: r.data })}`, { error: r.steps.some((s) => s.status === "falla") ? r.verdict : undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      void autoReport("error", message, { error: message });
    } finally {
      runningRef.current = false;
      setBusy(false);
      setProgress("");
    }
  }

  async function handleOneClick() {
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(true);
    setError("");
    setReportNote("");
    setSync(null);
    logRef.current = [];
    linkEventsRef.current = [];
    let backupTaken: SystelBackup | null = null;
    try {
      const runAddress = await connectScale("leer la balanza");
      if (runAddress === null || !linkRef.current) return;
      const client = new SystelClient(linkRef.current, { address: runAddress, log: logRef.current });
      setProgress("Leyendo lo que tiene la balanza (no cambia nada)…");
      const b = await takeSystelBackup(client, setProgress);
      backupTaken = b;
      setBackup(b);
      saveBackupLocally(b);
      void autoReport("leer la balanza", b.complete && b.layout ? `${b.plus.length} productos leídos (no se mandó nada)` : `lectura incompleta: ${b.detail}`, { backup: b });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      void autoReport("error", message, { error: message, backup: backupTaken });
    } finally {
      runningRef.current = false;
      setBusy(false);
      setProgress("");
    }
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
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>Con la balanza conectada por USB, Patagonia lee los productos que tiene. Los precios no se mandan desde acá.</p>
            </div>
            <div>
              <button disabled={busy} onClick={() => void handleOneClick()}>{busy ? "Un momento…" : "Leer la balanza"}</button>
              <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>La primera vez, Chrome pregunta qué puerto usar: elegí el que dice USB y tocá Conectar.</p>
            </div>
            <div>
              <button className="secondary" disabled={busy} onClick={() => void handleTicketBarcodes()}>Activar código por producto en la balanza</button>
              <button className="secondary" disabled={busy} onClick={() => void handleSalesDiagnostic()}>Diagnóstico completo (solo lectura)</button>
              <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>Para que el ticket traiga el código de barras de cada producto y el Mostrador cargue el producto con sus kilos y descuente el stock. Cambia solo esa opción de la balanza y lo comprueba.</p>
            </div>
            {salesDiag && (
              <div className="panel" style={{ padding: 12, display: "grid", gap: 6 }}>
                <strong>{salesDiag.verdict}</strong>
                {salesDiag.steps.map((s) => (
                  <div key={s.id} style={{ fontSize: 13 }}>
                    <span style={{ fontWeight: 700, color: s.status === "ok" ? "#15803d" : s.status === "falla" ? "#b91c1c" : s.status === "aviso" ? "#b45309" : "#6b7280" }}>
                      {s.status === "ok" ? "✓" : s.status === "falla" ? "✗" : s.status === "aviso" ? "!" : "–"} {s.label}:
                    </span>{" "}
                    {s.detail}
                  </div>
                ))}
                <span className="muted" style={{ fontSize: 12 }}>Solo lectura: no se cambió nada en la balanza ni en Patagonia.</span>
              </div>
            )}
            {ticketResult && (
              <p className={ticketResult.ok ? "message" : "message warning"} style={{ margin: 0 }}>
                {ticketResult.ok ? `✅ ${ticketResult.detail[0].toUpperCase()}${ticketResult.detail.slice(1)}.` : `No quedó activado: ${ticketResult.detail}. Ya nos llegó el aviso.`}
              </p>
            )}
            {progress && <p className="muted" style={{ margin: 0 }}>{progress}</p>}
            {error && <p className="message warning" style={{ margin: 0 }}>No se pudo: {error}. No se cambió nada en la balanza.</p>}
            {backup && !busy && !error && <p className={backup.complete ? "message" : "message warning"} style={{ margin: 0 }}>{backup.complete ? `Se leyeron ${backup.plus.length} productos de la balanza. No se cambió nada.` : `No se pudo leer todo: ${backup.detail}`}</p>}
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
