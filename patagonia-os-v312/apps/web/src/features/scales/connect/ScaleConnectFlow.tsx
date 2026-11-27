import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Monitor, TriangleAlert } from "lucide-react";
import type { EngineProduct, ProductProblem } from "../engine/types";
import { defaultScaleName, lastUseText, registerBranchScale, sameScaleCandidates, type BranchScale, type SameScaleCandidate } from "../registry/branch-scales";
import {
  foundScales,
  IDENTIFY_SCALE_KEY,
  runConnectorJob,
  sendPayload,
  sendResultView,
  whereText,
  type ConnectBinding,
  type ConnectComputer,
  type ConnectJob,
  type ConnectStatus,
  type FoundScale,
  type ScaleConnectPort,
  type SendOptions,
  type SendResultView
} from "./scale-connect-jobs";

/**
 * Mis balanzas por Patagonia Scale Connect (lógica en scale-connect-jobs.ts):
 * - ConnectorSend: "Enviar productos" a una balanza que está en una PC con Scale Connect. El envío lo hace el servicio;
 *   acá se ve el avance (cada 2 s) y el resultado comprobado, con los mismos textos que el envío por cable.
 * - ConnectorAdd: "Agregar balanza → En esta computadora con Scale Connect". La PC busca sus balanzas (solo lectura),
 *   la persona elige, "¿Es la misma?" como siempre, se registra y se vincula a ese puerto de esa PC.
 */

/**
 * Señal que se corta cuando la pantalla se cierra de verdad. En desarrollo (React.StrictMode) el efecto se monta, se
 * desmonta y se vuelve a montar enseguida: el corte se posterga un instante y el segundo montaje lo cancela, así el
 * envío no queda "cancelado" a mitad.
 */
function useUnmountSignal(): AbortSignal {
  const ctrl = useRef(new AbortController());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const c = ctrl.current;
    return () => {
      timer.current = setTimeout(() => c.abort(), 0);
    };
  }, []);
  return ctrl.current.signal;
}

function Progress({ job, text }: { job: ConnectJob | null; text: string }) {
  const done = job?.progress?.done ?? 0;
  const total = job?.progress?.total ?? 0;
  return (
    <div aria-live="polite">
      <div className="my-scale-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total || 100} aria-valuenow={done || undefined}>
        <div style={total ? { width: `${Math.round((done / total) * 100)}%` } : undefined} className={total ? "" : "indeterminate"} />
      </div>
      <p className="muted">{job?.progress?.text ?? text}</p>
    </div>
  );
}

function Problems({ title, items }: { title: string; items: ProductProblem[] }) {
  if (!items.length) return null;
  return (
    <details className="my-scale-problems" open={items.length <= 5}>
      <summary>{items.length === 1 ? `1 producto ${title}` : `${items.length} productos ${title}`}</summary>
      <ul className="my-scale-notes">
        {items.map((p) => (
          <li key={`${p.code}|${p.name}`}>
            <strong>{p.code} {p.name}</strong>: {p.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ConnectorSend(props: {
  port: ScaleConnectPort;
  branchId: string;
  scale: BranchScale;
  binding: ConnectBinding;
  products: EngineProduct[];
  options: SendOptions;
  onBack: () => void;
  onFinished: (view: SendResultView) => void;
}) {
  const { port, branchId, scale, binding, products, options, onBack, onFinished } = props;
  const [job, setJob] = useState<ConnectJob | null>(null);
  const [state, setState] = useState<{ kind: "trabajando" } | { kind: "listo"; view: SendResultView } | { kind: "error"; message: string }>({ kind: "trabajando" });
  const started = useRef(false);
  const signal = useUnmountSignal();

  useEffect(() => {
    // Una sola vez por pantalla: los productos y la balanza son los del momento en que se tocó "Enviar productos".
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const run = await runConnectorJob(
          port,
          { branchId, scaleKey: scale.key, kind: "send", payload: sendPayload(products, options), connector: binding },
          { onProgress: setJob, signal }
        );
        if (run.kind === "cancelado") return;
        if (run.kind === "apagada") return setState({ kind: "error", message: run.message });
        const view = sendResultView(run.job, run.items, products);
        setState({ kind: "listo", view });
        onFinished(view);
      } catch (error) {
        setState({ kind: "error", message: error instanceof Error ? error.message : "No se pudo encolar el envío." });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.kind === "trabajando") {
    return (
      <div className="my-scale-body">
        <p className="my-scale-status">
          <Monitor size={20} /> Enviando por Scale Connect ({binding.connectorName})…
        </p>
        <Progress job={job} text={job?.status === "running" ? "La computadora está hablando con la balanza…" : "Esperando a que la computadora tome el envío…"} />
        <p className="muted">Lo hace la computadora de la balanza: podés cerrar esta pantalla, el envío sigue igual.</p>
        <div className="my-scale-actions">
          <button className="secondary" onClick={onBack}>Volver a mis balanzas</button>
        </div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="my-scale-body">
        <p className="my-scale-status bad"><TriangleAlert size={20} /> {state.message}</p>
        <div className="my-scale-actions">
          <button className="secondary" onClick={onBack}>Volver a mis balanzas</button>
        </div>
      </div>
    );
  }
  const { view } = state;
  return (
    <div className="my-scale-body">
      <p className={`my-scale-status ${view.ok ? "ok" : "bad"}`}>
        {view.ok ? <CheckCircle2 size={22} /> : <TriangleAlert size={20} />} {view.headline}
      </p>
      {!view.ok && view.message && <p>{view.message}</p>}
      {view.next.length > 0 && (
        <ul className="my-scale-notes">
          {view.next.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      <Problems title="no quedaron bien en la balanza" items={view.failures} />
      <Problems title="no van a la balanza" items={view.skipped} />
      <div className="my-scale-actions">
        <button className="secondary" onClick={onBack}>Volver a mis balanzas</button>
      </div>
    </div>
  );
}

type AddPhase =
  | { kind: "elegir_pc" }
  | { kind: "buscando"; pc: ConnectComputer }
  | { kind: "encontradas"; pc: ConnectComputer; found: FoundScale[] }
  | { kind: "es_la_misma"; pc: ConnectComputer; scale: FoundScale; candidates: SameScaleCandidate[] }
  | { kind: "guardando" }
  | { kind: "listo"; name: string; pc: ConnectComputer }
  | { kind: "error"; message: string };

export function ConnectorAdd(props: { port: ScaleConnectPort; branchId: string; status: ConnectStatus; known: BranchScale[]; onBack: () => void; onAdded: () => void }) {
  const { port, branchId, status, known, onBack, onAdded } = props;
  const online = status.connectors.filter((c) => c.online);
  const [phase, setPhase] = useState<AddPhase>(() => (online.length === 1 ? { kind: "buscando", pc: online[0] } : { kind: "elegir_pc" }));
  const [job, setJob] = useState<ConnectJob | null>(null);
  const signal = useUnmountSignal();
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const searchedFor = useRef<AddPhase | null>(null);

  // Cada "buscando" (también "Buscar de nuevo") es un objeto nuevo: una sola búsqueda por cada uno.
  useEffect(() => {
    if (phase.kind !== "buscando" || searchedFor.current === phase) return;
    searchedFor.current = phase;
    const searchPhase = phase;
    const searching = phase.pc;
    const alive = () => phaseRef.current === searchPhase;
    void (async () => {
      try {
        const run = await runConnectorJob(
          port,
          { branchId, scaleKey: IDENTIFY_SCALE_KEY, kind: "read", payload: { mode: "identify" }, connector: searching },
          { onProgress: setJob, signal }
        );
        if (!alive() || run.kind === "cancelado") return;
        if (run.kind === "apagada") return setPhase({ kind: "error", message: run.message });
        setPhase({ kind: "encontradas", pc: searching, found: foundScales(run.items) });
      } catch (error) {
        if (alive()) setPhase({ kind: "error", message: error instanceof Error ? error.message : "No se pudo buscar las balanzas." });
      }
    })();
  }, [phase, port, branchId, signal]);

  async function save(pc: ConnectComputer, scale: FoundScale, sameKey: string | null) {
    setPhase({ kind: "guardando" });
    try {
      const key = await registerBranchScale(branchId, {
        key: sameKey,
        name: sameKey ? null : defaultScaleName(scale.label, known),
        family: scale.family,
        brand: scale.family,
        model: scale.label,
        identity: scale.identity
      });
      await port.bind(branchId, key, pc.id, scale.device);
      setPhase({ kind: "listo", name: known.find((s) => s.key === key)?.name ?? defaultScaleName(scale.label, known), pc });
      onAdded();
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "No se pudo agregar la balanza." });
    }
  }

  function choose(pc: ConnectComputer, scale: FoundScale) {
    // Como al agregar por cable (C22): si se parece a una registrada, se pregunta antes de registrar otra.
    const candidates = sameScaleCandidates(known, scale.family, scale.identity);
    if (candidates.length) setPhase({ kind: "es_la_misma", pc, scale, candidates });
    else void save(pc, scale, null);
  }

  const boundDevice = (pc: ConnectComputer, f: FoundScale) => status.bindings.find((b) => b.connectorId === pc.id && b.device?.id === f.device.id);

  return (
    <div className="my-scale-body">
      {phase.kind === "elegir_pc" && (
        <>
          <p className="my-scale-status"><Monitor size={20} /> ¿En qué computadora está la balanza?</p>
          {online.length === 0 && <p className="my-scale-warning">Ninguna computadora con Scale Connect está en línea en esta sucursal. Prendela (o revisá su internet) y probá de nuevo.</p>}
          <div className="my-scale-choices">
            {online.map((c) => (
              <button key={c.id} className="my-scale-choice" onClick={() => setPhase({ kind: "buscando", pc: c })}>
                <strong>{c.name}</strong>
                <span>En línea</span>
              </button>
            ))}
          </div>
        </>
      )}
      {phase.kind === "buscando" && (
        <>
          <p className="my-scale-status">Buscando balanzas en {phase.pc.name}…</p>
          <Progress job={job} text="Esperando a que la computadora empiece a buscar…" />
          <p className="muted">Solo se leen las balanzas: no se cambia nada.</p>
        </>
      )}
      {phase.kind === "encontradas" && (
        <>
          {phase.found.length === 0 ? (
            <p className="my-scale-status bad"><TriangleAlert size={20} /> {phase.pc.name} no encontró ninguna balanza. Revisá que esté prendida y con el cable puesto, y que no esté abierto el programa de la balanza.</p>
          ) : (
            <p className="my-scale-status">{phase.pc.name} encontró {phase.found.length === 1 ? "1 balanza" : `${phase.found.length} balanzas`}</p>
          )}
          <ul className="my-scale-list">
            {phase.found.map((f) => {
              const bound = boundDevice(phase.pc, f);
              const boundName = bound ? known.find((s) => s.key === bound.scaleKey)?.name ?? bound.scaleKey : null;
              return (
                <li key={f.deviceId} className="my-scale-item">
                  <div>
                    <strong>{f.label}</strong>
                    <span className="muted"> · {whereText(f.device)}</span>
                    {boundName && <p className="my-scale-item-status ok">Ya está agregada como "{boundName}"</p>}
                  </div>
                  {!boundName && (
                    <div className="my-scale-actions">
                      <button className="my-scale-primary" onClick={() => choose(phase.pc, f)}>Agregar esta</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="my-scale-actions">
            <button className="secondary" onClick={() => setPhase({ kind: "buscando", pc: phase.pc })}>Buscar de nuevo</button>
          </div>
        </>
      )}
      {phase.kind === "es_la_misma" && (
        <>
          {phase.candidates.map((c) => (
            <div key={c.key}>
              <p className="my-scale-status">¿Es la <strong>{c.name}</strong>?</p>
              <p className="muted">Ya está registrada en esta sucursal ({lastUseText(c.lastSeenAt)}).</p>
              <div className="my-scale-actions">
                <button className="my-scale-primary" onClick={() => void save(phase.pc, phase.scale, c.key)}>Sí, es esa</button>
              </div>
            </div>
          ))}
          <div className="my-scale-actions">
            <button className="secondary" onClick={() => void save(phase.pc, phase.scale, null)}>No, es otra balanza</button>
          </div>
        </>
      )}
      {phase.kind === "guardando" && <p className="my-scale-status">Guardando…</p>}
      {phase.kind === "listo" && (
        <p className="my-scale-status ok">
          <CheckCircle2 size={22} /> Listo: "{phase.name}" quedó en {phase.pc.name}. Tocá "Enviar productos" en la lista para pasarle los productos.
        </p>
      )}
      {phase.kind === "error" && <p className="my-scale-status bad"><TriangleAlert size={20} /> {phase.message}</p>}
      <div className="my-scale-actions">
        <button className="secondary" onClick={onBack}>Volver a mis balanzas</button>
      </div>
    </div>
  );
}
