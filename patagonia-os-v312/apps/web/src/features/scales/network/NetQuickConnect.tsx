import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { findNetScalesRaw, localNetworkPermission, netAgentVersion, testNetScale } from "../../inventory/kretz/net-port";
import { JackDrawing } from "./NetDrawings";
import { quickSearch, type QuickSearch } from "./net-quick";
import {
  addressAdvice,
  BRAND_LABEL,
  brandForPort,
  isValidIp,
  NO_SCALE_STEPS,
  normalizeIp,
  netDiagnostic,
  SEARCH_PORTS,
  stepText,
  type FoundScale,
  type SearchResult
} from "./net-wizard";

/**
 * "Conectar balanza por cable de red", camino corto:
 *   - busca sola apenas se abre (antes, revisa el programa de la PC);
 *   - UNA balanza → se conecta sola (onConnect), sin pantallas;
 *   - varias → cada una con su modelo y CONECTAR;
 *   - ninguna → pasos de a uno (luz, prendida, dirección), y busca sola cada pocos segundos y después de cada paso.
 */

const INSTALLER = "/instalar-impresora.bat";
/** Cada cuánto vuelve a buscar sola mientras se muestra un paso o falta el programa. */
const POLL_MS = 6000;

type View =
  | { kind: "buscando" }
  | { kind: "programa"; status: "sin_programa" | "viejo" | "bloqueado" }
  | { kind: "varias"; scales: FoundScale[] }
  | { kind: "paso"; index: number }
  | { kind: "a_mano" };

const deps = { agentVersion: netAgentVersion, permission: localNetworkPermission, find: findNetScalesRaw };

export function NetQuickConnect({
  onConnect,
  onBack,
  onReport
}: {
  onConnect: (scale: FoundScale) => void;
  onBack: () => void;
  onReport: (data: Record<string, unknown>) => Promise<boolean>;
}) {
  const [view, setView] = useState<View>({ kind: "buscando" });
  const [result, setResult] = useState<SearchResult | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const searching = useRef(false);
  const done = useRef(false);
  /** Cada montaje de la pantalla tiene su número: lo que vuelve de una búsqueda vieja no cambia nada. */
  const generation = useRef(0);
  const searches = useRef(0);
  const last = useRef<QuickSearch | null>(null);
  const reported = useRef(false);

  /** Busca y decide. silent = búsqueda de fondo: si no encuentra nada, no cambia la pantalla. */
  async function search(silent: boolean) {
    if (searching.current || done.current) return;
    const gen = generation.current;
    searching.current = true;
    if (!silent) setView({ kind: "buscando" });
    try {
      const s = await quickSearch(deps);
      searches.current++;
      last.current = s;
      if (done.current || gen !== generation.current) return;
      if (s.kind === "programa") {
        setView({ kind: "programa", status: s.status });
        return;
      }
      if (s.kind === "error") {
        if (!silent) setView({ kind: "programa", status: "sin_programa" });
        return;
      }
      setResult(s.result);
      if (s.quick.kind === "una") {
        done.current = true;
        onConnect(s.quick.scale);
        return;
      }
      if (s.quick.kind === "varias") {
        setView({ kind: "varias", scales: s.quick.scales });
        return;
      }
      // Ninguna: si venía de "buscando" o del programa, arranca el primer paso; si ya estaba en un paso, sigue ahí.
      const cur = viewRef.current;
      if (cur.kind === "buscando" || cur.kind === "programa") setView({ kind: "paso", index: 0 });
    } finally {
      if (gen === generation.current) searching.current = false;
    }
  }

  useEffect(() => {
    generation.current++;
    done.current = false;
    searching.current = false;
    void search(false);
    // Busca sola de fondo mientras falta el programa o se muestra un paso: apenas aparece, conecta.
    const t = window.setInterval(() => {
      const k = viewRef.current.kind;
      if (k === "programa" || k === "paso" || k === "a_mano") void search(true);
    }, POLL_MS);
    return () => {
      done.current = true;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** "YA ESTÁ" en un paso: busca ya; si sigue sin aparecer, pasa al siguiente. */
  async function stepDone(index: number) {
    setBusy(true);
    await search(true);
    setBusy(false);
    if (done.current || viewRef.current.kind === "varias" || viewRef.current.kind === "programa") return;
    if (index + 1 < NO_SCALE_STEPS.length) setView({ kind: "paso", index: index + 1 });
    else {
      setView({ kind: "a_mano" });
      // Recién acá va a soporte, solo, con todo lo que se probó.
      if (!reported.current) {
        reported.current = true;
        const s = last.current;
        void onReport(
          netDiagnostic({
            agentVersion: s?.version ?? null,
            chromePermission: s?.permission ?? null,
            result,
            step: "red",
            searches: searches.current,
            typedIp: null,
            lastError: s?.kind === "error" ? s.message : null
          })
        );
      }
    }
  }

  async function connectTyped() {
    const host = normalizeIp(typed);
    setTyped(host);
    if (!isValidIp(host)) {
      setMessage("Escribí la dirección como la muestra la balanza: cuatro números separados por puntos.");
      return;
    }
    setBusy(true);
    setMessage(null);
    for (const port of SEARCH_PORTS) {
      const r = await testNetScale({ host, port });
      if (r.ok) {
        setBusy(false);
        done.current = true;
        onConnect({ ip: host, port });
        return;
      }
    }
    setBusy(false);
    const advice = result ? addressAdvice(result) : null;
    setMessage(
      advice
        ? `No contesta en ${host}. Esa dirección no es de la red de esta computadora: ponele a la balanza ${advice.ip} con máscara ${advice.mask}.`
        : `No contesta en ${host}. Revisá que esté prendida y la luz del cable.`
    );
  }

  return (
    <div className="my-scale-body net-wizard">
      {view.kind === "buscando" && (
        <>
          <p className="my-scale-status">Buscando tu balanza en la red…</p>
          <div className="my-scale-bar" role="progressbar"><div className="indeterminate" /></div>
        </>
      )}

      {view.kind === "programa" && <AgentHelp status={view.status} />}

      {view.kind === "varias" && (
        <>
          <p className="my-scale-status">Hay {view.scales.length} balanzas en la red. ¿Cuál conectás?</p>
          <ul className="my-scale-list">
            {view.scales.map((s) => {
              const brand = brandForPort(s.port);
              return (
                <li key={`${s.ip}:${s.port}`} className="my-scale-item">
                  <div>
                    <strong>{brand ? BRAND_LABEL[brand] : "Balanza"}</strong>
                    <p className="my-scale-item-status off">Dirección {s.ip}</p>
                  </div>
                  <button
                    className="my-scale-primary"
                    onClick={() => {
                      done.current = true;
                      onConnect(s);
                    }}
                  >
                    CONECTAR
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="muted">Conectá una; para la otra, volvé a tocar "Conectar balanza por cable de red".</p>
        </>
      )}

      {view.kind === "paso" && <Step index={view.index} result={result} busy={busy} onDone={() => void stepDone(view.index)} />}

      {view.kind === "a_mano" && (
        <>
          <p className="my-scale-status"><TriangleAlert size={20} /> Todavía no aparece</p>
          <p>Sigo buscando sola. Si en el menú de la balanza ves su dirección (IP), escribila acá:</p>
          <div className="my-scale-actions">
            <input className="net-ip" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Por ejemplo 192.168.0.200" inputMode="decimal" aria-label="Dirección (IP) de la balanza" />
            <button className="my-scale-primary" disabled={busy} onClick={() => void connectTyped()}>{busy ? "PROBANDO…" : "CONECTAR"}</button>
          </div>
          <p className="muted">Ya le mandamos a soporte de Patagonia todo lo que se probó.</p>
        </>
      )}

      {message && <p className="my-scale-warning">{message}</p>}
      {view.kind !== "buscando" && <button className="secondary" onClick={onBack}>Volver</button>}
    </div>
  );
}

function Step({ index, result, busy, onDone }: { index: number; result: SearchResult | null; busy: boolean; onDone: () => void }) {
  const step = NO_SCALE_STEPS[index];
  const text = stepText(step, result ? addressAdvice(result) : null, result);
  return (
    <>
      <p className="my-scale-status net-step">
        <span className="net-step-n">{index + 1}</span>
        <span>{text.title}</span>
      </p>
      {step === "luz" && <JackDrawing lit />}
      {text.lines.map((l) => (step === "red" && /^(IP|Máscara):/.test(l) ? <p key={l} className="net-ip-big">{l}</p> : <p key={l}>{l}</p>))}
      <button className="my-scale-primary" disabled={busy} onClick={onDone}>{busy ? "BUSCANDO…" : "YA ESTÁ"}</button>
      <p className="muted">No hace falta tocar nada más: apenas aparezca, se conecta sola.</p>
    </>
  );
}

function AgentHelp({ status }: { status: "sin_programa" | "viejo" | "bloqueado" }) {
  if (status === "bloqueado") {
    return (
      <>
        <p className="my-scale-status"><TriangleAlert size={20} /> Chrome no deja que Patagonia hable con la balanza</p>
        <ol className="my-scale-net-steps">
          <li>Arriba, a la izquierda de la dirección de la página, tocá el candado.</li>
          <li>"Configuración del sitio" → "Red local" (o "Dispositivos de la red local") → "Permitir".</li>
          <li>Tocá RECARGAR.</li>
        </ol>
        <button className="my-scale-primary" onClick={() => window.location.reload()}>RECARGAR</button>
      </>
    );
  }
  return (
    <>
      <p className="my-scale-status">
        {status === "viejo" ? "Hay que actualizar el programa de Patagonia en esta computadora" : "Falta el programa de Patagonia en esta computadora"}
      </p>
      <p className="muted">Es el que habla con la balanza por la red. Se instala una sola vez.</p>
      <a className="my-scale-primary net-link-button" href={INSTALLER} download>{status === "viejo" ? "ACTUALIZAR" : "INSTALAR"}</a>
      <p className="muted">
        Abrí el archivo y esperá a que diga LISTO (si Windows avisa: "Más información" → "Ejecutar de todas formas"; si Chrome pregunta por la red local: "Permitir"). Apenas termine, Patagonia busca la balanza sola.
      </p>
    </>
  );
}
