import { useRef, useState } from "react";
import type { SystelExchangeLog } from "./systel-client";
import { discoverSystelLink } from "./systel-discovery";
import { runCreateLab, runPriceChangeLab, verifyCreateRestored, type LabReport } from "./systel-lab";
import { pickSystelPort, type SerialSystelLink, type SystelLinkEvent } from "./systel-serial";

/**
 * Laboratorio Systel: SOLO para una Cuora de banco del equipo de Patagonia. Se monta únicamente en una
 * compilación con VITE_SYSTEL_LAB=1 (ver Inventory.tsx); la de producción no lo incluye.
 * Cambio de precio y alta son pruebas separadas. El informe (JSON) lleva cada orden, respuesta, tiempo,
 * protocolo usado, resultado de cada paso y los eventos del cable.
 */
export default function SystelLabPanel() {
  const [plu, setPlu] = useState("7999");
  const [newPrice, setNewPrice] = useState("");
  const [name, setName] = useState("PRUEBA LAB");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<LabReport | null>(null);
  const [note, setNote] = useState("");
  const linkRef = useRef<SerialSystelLink | null>(null);
  const addressRef = useRef(0);
  const logRef = useRef<SystelExchangeLog[]>([]);
  const eventsRef = useRef<SystelLinkEvent[]>([]);

  async function connect(): Promise<SerialSystelLink | null> {
    if (linkRef.current) return linkRef.current;
    const port = await pickSystelPort();
    const found = await discoverSystelLink(port, logRef.current, setNote, null, 350, eventsRef.current);
    if (!found) {
      setNote("la balanza no contestó");
      return null;
    }
    linkRef.current = found.link;
    addressRef.current = found.address;
    return found.link;
  }

  async function run(kind: "precio" | "alta" | "alta_sin_control") {
    setBusy(true);
    setReport(null);
    try {
      const link = await connect();
      if (!link) return;
      const n = Number(plu);
      const r =
        kind === "precio"
          ? await runPriceChangeLab(link, {
              lab: true,
              address: addressRef.current,
              plu: n,
              newPriceRaw: Number(newPrice),
              log: logRef.current,
              confirm: async (initial) => window.confirm(`Balanza de BANCO. PLU ${initial.number} "${initial.name.trim()}": precio ${initial.prices[0]} → ${newPrice}, y después se restaura. ¿Seguir?`)
            })
          : await runCreateLab(link, {
              lab: true,
              address: addressRef.current,
              plu: n,
              name,
              priceRaw: Number(newPrice),
              saleType: "P",
              variant: kind === "alta" ? "con" : "sin_experimental",
              log: logRef.current,
              confirm: async () => window.confirm(`Balanza de BANCO. Alta del PLU ${n} ${kind === "alta" ? "con control" : "SIN control (experimental)"}. Después hay que borrarlo a mano. ¿Seguir?`)
            });
      setReport(r);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function verifyRestore() {
    if (!report || !linkRef.current) return;
    const step = await verifyCreateRestored(linkRef.current, report, logRef.current);
    setReport({ ...report, steps: [...report.steps, step], outcome: step.ok ? report.outcome : "fallo_al_restaurar", manualAction: step.ok ? null : report.manualAction });
  }

  function download() {
    const data = JSON.stringify({ report, linkEvents: eventsRef.current, log: logRef.current }, null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    a.download = `laboratorio_systel_${report?.test ?? "sin_prueba"}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
  }

  return (
    <div className="panel" style={{ width: "100%", marginTop: 12, display: "grid", gap: 8, border: "2px dashed #b45309" }}>
      <p style={{ margin: 0, fontWeight: 700 }}>LABORATORIO Systel: solo balanza de banco</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label>PLU <input value={plu} onChange={(e) => setPlu(e.target.value)} style={{ width: 80 }} disabled={busy} /></label>
        <label>Precio (crudo) <input value={newPrice} onChange={(e) => setNewPrice(e.target.value)} style={{ width: 90 }} disabled={busy} /></label>
        <label>Nombre (alta) <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 160 }} disabled={busy} /></label>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button disabled={busy} onClick={() => void run("precio")}>Probar cambio de precio</button>
        <button className="secondary" disabled={busy} onClick={() => void run("alta")}>Probar alta (con control)</button>
        <button className="secondary" disabled={busy} onClick={() => void run("alta_sin_control")}>Alta SIN control (experimental)</button>
        {report?.manualAction && <button className="secondary" disabled={busy} onClick={() => void verifyRestore()}>Verificar restauración</button>}
        {report && <button className="secondary" onClick={download}>Descargar informe</button>}
      </div>
      {note && <p className="muted" style={{ margin: 0 }}>{note}</p>}
      {report && (
        <div style={{ fontSize: 13 }}>
          <p style={{ margin: "4px 0" }}><b>{report.test}</b>: {report.outcome} · protocolo {report.protocol.signature ? `S${report.protocol.signature.protocolVersion}` : "?"} · formato {report.protocol.layout ?? "?"} · lectura {report.protocol.readFn ?? "?"} · escritura {report.protocol.writeFn ?? "?"}</p>
          {report.manualAction && <p className="message warning" style={{ margin: "4px 0" }}>{report.manualAction}</p>}
          <ol style={{ margin: 0 }}>
            {report.steps.map((s, i) => (
              <li key={i}>{s.ok ? "✔" : "✖"} {s.name}: {s.detail} ({s.ms} ms, {s.commands.length} órdenes)</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
