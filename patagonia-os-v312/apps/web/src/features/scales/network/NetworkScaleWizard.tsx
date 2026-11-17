import { useState } from "react";
import { CheckCircle2, Printer, Search, TriangleAlert } from "lucide-react";
import { findNetScalesRaw, localNetworkPermission, netAgentVersion, testNetScale } from "../../inventory/kretz/net-port";
import { CableToDrawing, JackDrawing, ScaleDrawing } from "./NetDrawings";
import { NetScaleSheetPrint, SHEET_BRANDS } from "./NetScaleSheet";
import {
  agentStatus,
  analyzeSearch,
  brandForPort,
  isValidIp,
  NET_BRANDS,
  netBrand,
  netDiagnostic,
  nextScaleName,
  normalizeIp,
  parseFindResponse,
  situationText,
  unreachableAdvice,
  type AgentStatus,
  type CableTo,
  type NetBrandId,
  type SearchResult,
  type Situation
} from "./net-wizard";
import type { ScaleChoice } from "../engine/choice";

/**
 * "Conectar balanza por cable de red": un paso por pantalla, un botón grande por paso.
 *
 *   marca → adónde va el cable → luz del cable → prendé la balanza → BUSCAR → (programa de la PC) → encontradas → conectar
 *
 * Al tocar CONECTAR, "Mis balanzas" sigue con lo de siempre: lee la balanza (prueba real), pasa los productos
 * comprobando cada uno y prueba la etiqueta. Aura (sin red), Cuora Neo (sin conexión directa) y otras marcas tienen
 * su propio camino claro en vez de trabarse.
 */

export interface NetConnectTarget {
  host: string;
  port: number;
  choice: ScaleChoice;
  name: string;
  brand: NetBrandId;
}

type Step =
  | { kind: "marca" }
  | { kind: "usb" }
  | { kind: "archivo" }
  | { kind: "foto" }
  | { kind: "cable" }
  | { kind: "luz" }
  | { kind: "sin_luz" }
  | { kind: "prender" }
  | { kind: "buscar" }
  | { kind: "buscando" }
  | { kind: "programa"; status: AgentStatus }
  | { kind: "resultado"; situation: Situation };

const INSTALLER = "/instalar-impresora.bat";
const PING_URL = "http://127.0.0.1:9101/ping";

export function NetworkScaleWizard({
  existingNames,
  onConnect,
  onUsb,
  onBack,
  onReport,
  startAt
}: {
  existingNames: string[];
  onConnect: (t: NetConnectTarget) => void;
  /** Kretz Aura: no tiene red, va por USB (abre la lista de Chrome con este mismo click). */
  onUsb: (choice: ScaleChoice) => void;
  onBack: () => void;
  onReport: (data: Record<string, unknown>) => Promise<boolean>;
  /** "Buscar de nuevo en la red" desde una balanza ya agregada (la dirección cambió). */
  startAt?: { brand: NetBrandId };
}) {
  const [step, setStep] = useState<Step>(startAt ? { kind: "buscar" } : { kind: "marca" });
  const [brand, setBrand] = useState<NetBrandId>(startAt?.brand ?? "auto");
  const [cableTo, setCableTo] = useState<CableTo | null>(startAt ? "no_se" : null);
  const [agentVersion, setAgentVersion] = useState<number | null>(null);
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState("");
  const [showTyped, setShowTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [report, setReport] = useState<"idle" | "sending" | "ok" | "fail">("idle");
  const [printing, setPrinting] = useState(false);
  const b = netBrand(brand);
  const ports = b.ports.length ? b.ports : netBrand("auto").ports;

  function chooseBrand(id: NetBrandId) {
    setBrand(id);
    setMessage(null);
    const path = netBrand(id).path;
    if (path === "usb") return setStep({ kind: "usb" });
    if (path === "archivo") return setStep({ kind: "archivo" });
    if (path === "foto") return setStep({ kind: "foto" });
    setStep({ kind: "cable" });
  }

  async function search() {
    setStep({ kind: "buscando" });
    setMessage(null);
    setShowTyped(false);
    const [version, perm] = await Promise.all([netAgentVersion(), localNetworkPermission()]);
    setAgentVersion(version);
    setPermission(perm);
    const status = agentStatus(version, perm);
    if (status !== "listo") {
      setStep({ kind: "programa", status });
      return;
    }
    try {
      const r = parseFindResponse(await findNetScalesRaw(ports), ports);
      setResult(r);
      const situation = analyzeSearch({ brand, cableTo: cableTo ?? "no_se", result: r });
      if (situation.kind === "encontradas") {
        const taken = [...existingNames];
        const next: Record<string, string> = {};
        for (const s of situation.scales) {
          const n = nextScaleName(taken);
          taken.push(n);
          next[`${s.ip}:${s.port}`] = n;
        }
        setNames(next);
      }
      setStep({ kind: "resultado", situation });
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      setStep({ kind: "programa", status: "sin_programa" });
    }
  }

  function connectFound(ip: string, port: number) {
    const found = brandForPort(port) ?? (brand === "systel-cuora-max" ? "systel-cuora-max" : "kretz-report");
    const choice = netBrand(found).choice ?? "kretz-report";
    onConnect({ host: ip, port, choice, brand: found, name: names[`${ip}:${port}`]?.trim() || nextScaleName(existingNames) });
  }

  async function connectTyped() {
    const host = normalizeIp(typed);
    setTyped(host);
    if (!isValidIp(host)) {
      setMessage("Escribí la dirección como la muestra la balanza, con cuatro números separados por puntos (por ejemplo 192.168.0.200).");
      return;
    }
    setBusy(true);
    setMessage(null);
    // Con la marca elegida se prueba su puerto; con "No sé", los de todas.
    for (const port of ports) {
      const r = await testNetScale({ host, port });
      if (r.ok) {
        setBusy(false);
        connectFound(host, port);
        return;
      }
      if (r.kind === "sin_programa") {
        setBusy(false);
        setStep({ kind: "programa", status: "sin_programa" });
        return;
      }
      setLastError(r.message);
    }
    setBusy(false);
    setMessage(unreachableAdvice(host, brand, { local: result?.local ?? [] }).text);
  }

  async function sendDiagnostic() {
    setReport("sending");
    const situation = step.kind === "resultado" ? step.situation : null;
    const ok = await onReport(netDiagnostic({ brand, cableTo, agentVersion, chromePermission: permission, askedPorts: ports, result, situation, typedIp: typed || null, lastError }));
    setReport(ok ? "ok" : "fail");
  }

  const searched = step.kind === "resultado" || step.kind === "programa";

  return (
    <div className="my-scale-body net-wizard">
      {step.kind === "marca" && (
        <>
          <p className="my-scale-status">¿Qué balanza es?</p>
          <p className="muted">Fijate el nombre arriba de la pantalla o en la etiqueta de atrás.</p>
          <div className="net-brands">
            {NET_BRANDS.map((x) => (
              <button key={x.id} className="my-scale-choice net-brand" onClick={() => chooseBrand(x.id)}>
                {x.id === "auto" ? <Search size={40} className="net-brand-icon" /> : <ScaleDrawing brand={x.id} size={96} />}
                <strong>{x.label}</strong>
                <span>{x.hint}</span>
              </button>
            ))}
          </div>
          <button className="secondary" onClick={onBack}>Volver</button>
        </>
      )}

      {step.kind === "usb" && (
        <>
          <p className="my-scale-status">La Kretz Aura no tiene cable de red</p>
          <p>Se conecta con su cable a la computadora (USB). Enchufalo, prendé la balanza y tocá CONECTAR POR USB. Se abre una lista: elegí la balanza y tocá "Conectar".</p>
          <div className="my-scale-actions">
            <button className="my-scale-primary" onClick={() => onUsb("kretz-aura")}>CONECTAR POR USB</button>
            <button className="secondary" onClick={() => setStep({ kind: "marca" })}>Volver</button>
          </div>
        </>
      )}

      {step.kind === "archivo" && (
        <>
          <p className="my-scale-status">La Systel Cuora Neo no se conecta directo</p>
          <p>Patagonia no puede hablarle a la Neo ni por cable de red ni por USB: la Neo solo carga productos desde un archivo.</p>
          <ol className="my-scale-net-steps">
            <li>En Stock, tocá el botón "Balanza" → "Descargar lista para balanza".</li>
            <li>Cargá esa lista en la balanza con el programa de Systel (o pedile a tu técnico de Systel que la cargue).</li>
            <li>En Mostrador, los tickets de la balanza se escanean igual que con cualquier balanza.</li>
          </ol>
          <p className="muted">Si querés que Patagonia le mande los precios sola, avisanos: lo estamos armando.</p>
          <div className="my-scale-actions">
            <button className="secondary" onClick={() => void sendDiagnostic()} disabled={report === "sending"}>Avisar a soporte que tengo una Neo</button>
            <button className="secondary" onClick={() => setStep({ kind: "marca" })}>Volver</button>
          </div>
          <ReportState state={report} />
        </>
      )}

      {step.kind === "foto" && (
        <>
          <p className="my-scale-status">Todavía no conocemos esa balanza</p>
          <ol className="my-scale-net-steps">
            <li>Sacale una foto a la etiqueta de atrás de la balanza (donde dice marca, modelo y número de serie).</li>
            <li>Mandala por WhatsApp a soporte de Patagonia, con el nombre de tu local.</li>
            <li>Mientras tanto: Stock → botón "Balanza" → "Descargar lista para balanza" para cargar los precios a mano.</li>
          </ol>
          <div className="my-scale-actions">
            <button className="my-scale-primary" onClick={() => void sendDiagnostic()} disabled={report === "sending"}>AVISAR A SOPORTE</button>
            <button className="secondary" onClick={() => chooseBrand("auto")}>Buscarla sola en la red</button>
            <button className="secondary" onClick={() => setStep({ kind: "marca" })}>Volver</button>
          </div>
          <ReportState state={report} />
        </>
      )}

      {step.kind === "cable" && (
        <>
          <StepTitle n={1} text="Enchufá el cable en la balanza (atrás, abajo). ¿Dónde enchufaste la otra punta?" />
          <div className="net-brands">
            <button className="my-scale-choice net-brand" onClick={() => { setCableTo("router"); setStep({ kind: "luz" }); }}>
              <CableToDrawing to="router" />
              <strong>En el router o módem</strong>
              <span>La cajita de internet del local</span>
            </button>
            <button className="my-scale-choice net-brand" onClick={() => { setCableTo("pc"); setStep({ kind: "luz" }); }}>
              <CableToDrawing to="pc" />
              <strong>En la computadora</strong>
              <span>Directo, sin router</span>
            </button>
            <button className="my-scale-choice net-brand" onClick={() => { setCableTo("no_se"); setStep({ kind: "luz" }); }}>
              <Search size={40} className="net-brand-icon" />
              <strong>No sé</strong>
              <span>Patagonia se da cuenta sola</span>
            </button>
          </div>
          <button className="secondary" onClick={() => setStep({ kind: "marca" })}>Volver</button>
        </>
      )}

      {step.kind === "luz" && (
        <>
          <StepTitle n={2} text="Mirá la luz al lado del cable, en la balanza. ¿Está prendida?" />
          <div className="net-art">
            <JackDrawing lit />
            <JackDrawing lit={false} />
          </div>
          <div className="my-scale-actions">
            <button className="my-scale-primary" onClick={() => setStep({ kind: "prender" })}>SÍ, ESTÁ PRENDIDA</button>
            <button className="secondary" onClick={() => setStep({ kind: "sin_luz" })}>No, está apagada</button>
            <button className="secondary" onClick={() => setStep({ kind: "cable" })}>Volver</button>
          </div>
        </>
      )}

      {step.kind === "sin_luz" && (
        <>
          <p className="my-scale-status"><TriangleAlert size={20} /> La luz apagada es el cable</p>
          <JackDrawing lit={false} />
          <ol className="my-scale-net-steps">
            <li>Fijate que la balanza esté prendida.</li>
            <li>Sacá el cable de la balanza y volvé a ponerlo hasta que haga clic. Lo mismo en la otra punta (router o computadora).</li>
            <li>Si sigue apagada, probá con otro cable: el cable está roto.</li>
          </ol>
          <div className="my-scale-actions">
            <button className="my-scale-primary" onClick={() => setStep({ kind: "prender" })}>YA SE PRENDIÓ</button>
            <button className="secondary" onClick={() => setStep({ kind: "luz" })}>Volver</button>
          </div>
        </>
      )}

      {step.kind === "prender" && (
        <>
          <StepTitle n={3} text="Prendé la balanza y esperá a que muestre el peso en cero." />
          <ScaleDrawing brand={brand === "auto" ? "kretz-report" : brand} size={140} />
          <div className="my-scale-actions">
            <button className="my-scale-primary" onClick={() => setStep({ kind: "buscar" })}>YA ESTÁ PRENDIDA</button>
            <button className="secondary" onClick={() => setStep({ kind: "luz" })}>Volver</button>
          </div>
        </>
      )}

      {step.kind === "buscar" && (
        <>
          <StepTitle n={4} text="Tocá BUSCAR. Patagonia busca la balanza sola en la red." />
          <div className="my-scale-actions">
            <button className="my-scale-primary net-big" onClick={() => void search()}><Search size={20} /> BUSCAR</button>
            <button className="secondary" onClick={() => setStep(startAt ? { kind: "marca" } : { kind: "prender" })}>Volver</button>
          </div>
        </>
      )}

      {step.kind === "buscando" && (
        <>
          <p className="my-scale-status">Buscando tu balanza en la red…</p>
          <div className="my-scale-bar" role="progressbar"><div className="indeterminate" /></div>
          <p className="muted">Tarda unos segundos.</p>
        </>
      )}

      {step.kind === "programa" && <AgentHelp status={step.status} onRetry={() => void search()} onBack={() => setStep({ kind: "buscar" })} />}

      {step.kind === "resultado" && (
        <ResultView
          situation={step.situation}
          brand={brand}
          names={names}
          onName={(k, v) => setNames((n) => ({ ...n, [k]: v }))}
          onConnect={connectFound}
          onRetry={() => void search()}
          onTyped={() => setShowTyped(true)}
        />
      )}

      {step.kind === "resultado" && (showTyped || step.situation.kind === "nada") && (
        <div className="net-typed">
          <p className="muted">Último recurso: la dirección que dice la balanza en {b.menu ? b.menu.path : "su menú de red"}.</p>
          <div className="my-scale-actions">
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Por ejemplo 192.168.0.200" inputMode="decimal" aria-label="Dirección (IP) de la balanza" />
            <button className="secondary" disabled={busy} onClick={() => void connectTyped()}>{busy ? "Probando…" : "CONECTAR"}</button>
          </div>
        </div>
      )}

      {message && <p className="my-scale-warning">{message}</p>}

      {searched && (
        <div className="net-footer">
          <button className="my-scale-link" onClick={() => void sendDiagnostic()} disabled={report === "sending"}>Mandar diagnóstico a soporte</button>
          <button className="my-scale-link" onClick={() => setPrinting(true)}><Printer size={14} /> Imprimir hoja para dejar al lado de la balanza</button>
          <button className="my-scale-link" onClick={onBack}>Salir</button>
          <ReportState state={report} />
        </div>
      )}

      {printing && <NetScaleSheetPrint brands={SHEET_BRANDS.includes(brand) ? [brand] : SHEET_BRANDS} onDone={() => setPrinting(false)} />}
    </div>
  );
}

function StepTitle({ n, text }: { n: number; text: string }) {
  return (
    <p className="my-scale-status net-step">
      <span className="net-step-n">{n}</span>
      <span>{text}</span>
    </p>
  );
}

function ReportState({ state }: { state: "idle" | "sending" | "ok" | "fail" }) {
  if (state === "idle") return null;
  return (
    <p className="muted">
      {state === "sending" ? "Mandando el diagnóstico…" : state === "ok" ? "Listo: soporte de Patagonia ya tiene todo lo que necesita." : "No se pudo mandar. Sacale una foto a esta pantalla y mandala por WhatsApp."}
    </p>
  );
}

function AgentHelp({ status, onRetry, onBack }: { status: AgentStatus; onRetry: () => void; onBack: () => void }) {
  if (status === "bloqueado") {
    return (
      <>
        <p className="my-scale-status"><TriangleAlert size={20} /> Chrome no deja que Patagonia hable con la balanza</p>
        <ol className="my-scale-net-steps">
          <li>Arriba, a la izquierda de la dirección de la página, tocá el candado (o el ícono de ajustes).</li>
          <li>Tocá "Configuración del sitio".</li>
          <li>Buscá "Red local" (o "Dispositivos de la red local") y ponelo en "Permitir".</li>
          <li>Volvé acá y tocá RECARGAR.</li>
        </ol>
        <div className="my-scale-actions">
          <button className="my-scale-primary" onClick={() => window.location.reload()}>RECARGAR</button>
          <button className="secondary" onClick={onBack}>Volver</button>
        </div>
        <p className="muted">
          ¿Todavía no instalaste el programa de Patagonia en esta computadora? <a href={INSTALLER} download>Descargalo acá</a> y esperá a que diga LISTO.
        </p>
      </>
    );
  }
  const old = status === "viejo";
  return (
    <>
      <p className="my-scale-status">
        {old ? "Hay que actualizar el programa de Patagonia en esta computadora" : "Falta el programa de Patagonia en esta computadora"}
      </p>
      <p className="muted">Es el que habla con la balanza por la red (el mismo de la impresora de tickets). Se instala una sola vez.</p>
      <ol className="my-scale-net-steps">
        <li>Tocá {old ? "ACTUALIZAR" : "DESCARGAR"} y abrí el archivo con doble clic. Si Windows avisa, tocá "Más información" → "Ejecutar de todas formas".</li>
        <li>Esperá a que la ventana negra diga LISTO. No la cierres antes.</li>
        <li>Si Chrome pregunta si permitís acceder a la red local, tocá "Permitir".</li>
        <li>Tocá YA LO INSTALÉ.</li>
      </ol>
      <div className="my-scale-actions">
        <a className="my-scale-primary net-link-button" href={INSTALLER} download>{old ? "ACTUALIZAR" : "DESCARGAR"}</a>
        <button className="secondary" onClick={onRetry}><CheckCircle2 size={16} /> YA LO INSTALÉ</button>
        <button className="secondary" onClick={onBack}>Volver</button>
      </div>
      {!old && (
        <details className="net-details">
          <summary>¿Ya lo instalaste y sigue apareciendo esto?</summary>
          <ol className="my-scale-net-steps">
            <li>
              Abrí <a href={PING_URL} target="_blank" rel="noreferrer">esta prueba</a> (se abre en otra pestaña).
            </li>
            <li>Si en esa pestaña dice <strong>"ok":true</strong>, el programa anda y Chrome lo está bloqueando: en esta página tocá el candado de arriba → "Configuración del sitio" → "Red local" → "Permitir", y recargá.</li>
            <li>Si dice que no se puede acceder, el programa no está prendido: reiniciá la computadora o volvé a abrir el instalador hasta que diga LISTO.</li>
          </ol>
        </details>
      )}
    </>
  );
}

function ResultView({
  situation,
  brand,
  names,
  onName,
  onConnect,
  onRetry,
  onTyped
}: {
  situation: Situation;
  brand: NetBrandId;
  names: Record<string, string>;
  onName: (key: string, value: string) => void;
  onConnect: (ip: string, port: number) => void;
  onRetry: () => void;
  onTyped: () => void;
}) {
  const text = situationText(situation, brand);
  if (situation.kind === "encontradas") {
    return (
      <>
        <p className="my-scale-status ok"><CheckCircle2 size={22} /> {text.title}</p>
        {text.steps.map((s) => <p key={s} className="muted">{s}</p>)}
        <ul className="my-scale-list">
          {situation.scales.map((s) => {
            const key = `${s.ip}:${s.port}`;
            return (
              <li key={key} className="my-scale-item net-found">
                <ScaleDrawing brand={s.brand ?? "otra"} size={72} />
                <div className="net-found-info">
                  <strong>{s.brand ? netBrand(s.brand).label : "Balanza"}</strong>
                  <span className="muted">Dirección {s.ip}</span>
                  <label>
                    Nombre
                    <input value={names[key] ?? ""} onChange={(e) => onName(key, e.target.value)} maxLength={40} />
                  </label>
                </div>
                <button className="my-scale-primary" onClick={() => onConnect(s.ip, s.port)}>CONECTAR</button>
              </li>
            );
          })}
        </ul>
        {situation.scales.length > 1 && <p className="muted">Conectá una por una. Cuando termines con una, volvé a "Agregar balanza" para la siguiente.</p>}
      </>
    );
  }
  return (
    <>
      <p className="my-scale-status"><TriangleAlert size={20} /> {text.title}</p>
      {situation.kind === "sin_luz" && <JackDrawing lit={false} />}
      {situation.kind === "cable_directo" && <CableToDrawing to="pc" />}
      <ol className="my-scale-net-steps">
        {text.steps.map((s) => <li key={s}>{s}</li>)}
      </ol>
      <div className="my-scale-actions">
        <button className="my-scale-primary" onClick={onRetry}><Search size={18} /> BUSCAR DE NUEVO</button>
        {situation.kind !== "nada" && <button className="secondary" onClick={onTyped}>Escribir la dirección a mano</button>}
      </div>
    </>
  );
}
