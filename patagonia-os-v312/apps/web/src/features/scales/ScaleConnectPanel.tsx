import { useCallback, useEffect, useRef, useState } from "react";
import { Monitor } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { connectorStatus, countdownText, formatCode, newlyPaired, secondsLeft, sortConnectors, type PairingCode, type ScaleConnector } from "./scale-connect-logic";
import { createPairingCode, listScaleConnectors, renameScaleConnector, revokeScaleConnector } from "./scale-connect-service";

/**
 * Mis balanzas → "Computadoras con Scale Connect" (plan balanzas v2 §5.4, migración 226). Solo dueño y administrador.
 *
 * "Agregar esta computadora" pide un código de 8 caracteres (10 minutos, un solo uso) y muestra los pasos; mientras
 * el código está a la vista se revisa la lista cada 5 s para avisar "¡Listo!" cuando la PC se vincula. La lista
 * muestra cada PC con su estado según el latido (en línea / sin conexión), su versión y sus balanzas, y deja
 * renombrarla o desvincularla. Si la base todavía no tiene la migración 226, no se muestra nada.
 */
export function ScaleConnectPanel({ branchId }: { branchId: string | null }) {
  const { profile } = useAuth();
  const canManage = profile?.role === "owner" || profile?.role === "admin";
  const [connectors, setConnectors] = useState<ScaleConnector[] | null>(null);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const beforeRef = useRef<ScaleConnector[]>([]);

  const reload = useCallback(async () => {
    try {
      const list = await listScaleConnectors();
      setConnectors(list === null ? null : sortConnectors(list));
      return list;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (canManage) void reload();
  }, [canManage, reload]);

  // Con el código a la vista: reloj cada segundo y lista cada 5 s para enterarse cuando la PC se vincula.
  useEffect(() => {
    if (!pairing) return;
    const tick = setInterval(() => setNow(new Date()), 1000);
    const poll = setInterval(() => {
      void reload().then((list) => {
        if (!list) return;
        const added = newlyPaired(beforeRef.current, list);
        if (added) {
          setPairing(null);
          setMessage({ text: `¡Listo! Se vinculó "${added.name}".`, tone: "ok" });
        }
      });
    }, 5000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [pairing, reload]);

  if (!canManage || connectors === null) return null;

  async function handleAdd() {
    setBusy(true);
    setMessage(null);
    try {
      beforeRef.current = connectors ?? [];
      const code = await createPairingCode(branchId);
      setNow(new Date());
      setPairing(code);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "No se pudo pedir el código.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(c: ScaleConnector) {
    const name = window.prompt("Nombre de la computadora (por ejemplo \"Caja 1\" o \"PC del fondo\"):", c.name)?.trim();
    if (!name || name === c.name) return;
    try {
      await renameScaleConnector(c.id, name);
      await reload();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "No se pudo cambiar el nombre.");
    }
  }

  async function handleRevoke(c: ScaleConnector) {
    if (
      !window.confirm(
        `¿Desvincular "${c.name}"?\n\nEsa computadora deja de recibir envíos al instante y lo que tenía pendiente queda cancelado. Para volver a usarla hay que vincularla de nuevo con un código.`,
      )
    )
      return;
    try {
      await revokeScaleConnector(c.id);
      await reload();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "No se pudo desvincular.");
    }
  }

  const left = pairing ? secondsLeft(pairing.expiresAt, now) : 0;
  const active = connectors.filter((c) => c.status === "active");
  const revoked = connectors.filter((c) => c.status === "revoked");

  return (
    <div className="my-scale-body" style={{ borderTop: "1px solid #e5e7eb", paddingTop: 16, marginTop: 16 }}>
      <p className="my-scale-status">
        <Monitor size={20} /> Computadoras con Scale Connect
      </p>
      <p className="muted">Scale Connect es un programa que se instala una vez en la computadora de la balanza y se ocupa de conectarla, sin depender de Chrome.</p>

      {active.length > 0 && (
        <ul className="my-scale-list">
          {[...active, ...revoked.slice(0, 3)].map((c) => {
            const st = connectorStatus(c, now);
            return (
              <li key={c.id} className="my-scale-item">
                <div>
                  <strong>{c.name}</strong>
                  {c.branchName && <span className="muted"> · {c.branchName}</span>}
                  <p className={`my-scale-item-status ${st.tone === "muted" ? "" : st.tone}`}>
                    {st.text}
                    {c.version ? ` · versión ${c.version}` : ""}
                  </p>
                  {c.status === "active" && c.scales.length > 0 && <p className="muted" style={{ margin: "2px 0 0" }}>Balanzas: {c.scales.map((s) => s.name).join(", ")}</p>}
                </div>
                {c.status === "active" && (
                  <div className="my-scale-actions">
                    <button className="secondary" onClick={() => void handleRename(c)}>Cambiar nombre</button>
                    <button className="secondary" onClick={() => void handleRevoke(c)}>Desvincular</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {active.length === 0 && !pairing && <p className="muted">Todavía no hay computadoras vinculadas.</p>}

      {pairing && left > 0 ? (
        <div className="my-scale-item" style={{ display: "block" }}>
          <p style={{ margin: 0 }}>Instalá Patagonia Scale Connect y escribí este código:</p>
          <p style={{ fontSize: 34, fontWeight: 800, letterSpacing: 4, fontFamily: "Consolas, monospace", margin: "10px 0" }} aria-label="Código de vinculación">
            {formatCode(pairing.code)}
          </p>
          <ol style={{ margin: "0 0 8px", paddingLeft: 20 }}>
            <li>Instalá Patagonia Scale Connect en la computadora donde está conectada la balanza.</li>
            <li>Al terminar se abre una página para vincularla (si no, entrá a <b>http://127.0.0.1:9120/vincular</b> en esa computadora).</li>
            <li>Escribí este código y un nombre para la computadora, por ejemplo "Caja 1".</li>
          </ol>
          <p className="muted" style={{ margin: 0 }}>{countdownText(left)} · sirve una sola vez.</p>
          <button className="secondary" style={{ marginTop: 10 }} onClick={() => setPairing(null)}>Cerrar</button>
        </div>
      ) : (
        <button className="secondary" disabled={busy} onClick={() => void handleAdd()}>
          {pairing ? "El código venció: pedir otro" : busy ? "Pidiendo código…" : "Agregar esta computadora"}
        </button>
      )}
      {message && <p className={`my-scale-item-status ${message.tone === "ok" ? "ok" : "warn"}`}>{message.text}</p>}
    </div>
  );
}
