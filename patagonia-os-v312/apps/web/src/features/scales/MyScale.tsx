import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Plus, Scale, TriangleAlert } from "lucide-react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { releaseSerialEverywhere } from "../inventory/kretz/serial-tabs";
import { connectBranchScale, type BranchConnectResult } from "./engine/connect-branch";
import { markSynced } from "./engine/engine";
import { adaptersForChoice } from "./engine/live";
import { friendlyKind, friendlyMessage } from "./engine/friendly";
import { choiceLabel, SCALE_CHOICES, type ScaleChoice } from "./engine/choice";
import { loadRememberedScale, rememberScale } from "./engine/memory";
import { emptyDiag, type ConnectDiag, type EngineProduct, type EngineStep, type PendingItem, type PreparedSync, type ScaleSession } from "./engine/types";
import { checkScaleFormats, choiceForScale, defaultScaleName, listBranchScales, registerBranchScale, removeBranchScale, renameBranchScale, scaleStatus, type BranchScale } from "./registry/branch-scales";
import { bindingFor, forgetBinding, saveBinding } from "./registry/local-bindings";
import { setScaleLinks } from "./sale/scale-sale-service";
import { submitScaleSupportReport } from "./support-service";

/**
 * "Mis balanzas": la única pantalla de balanza que ve el cliente.
 *
 *   Agregar balanza → ¿qué balanza es? → elegir el cable → Patagonia la reconoce → pasar productos
 *
 * Cada balanza de la sucursal es una fila (migración 134) con su nombre; en cada computadora se recuerda su cable
 * (local-bindings). Agregar otra nunca pisa ni desconecta la primera. Puertos, velocidades, protocolos y
 * diagnósticos quedan en "Herramientas técnicas" (ScaleSupportTools), solo para soporte.
 */

type Phase =
  | { kind: "inicio" }
  | { kind: "elegir_marca" }
  | { kind: "trabajando"; stage: "conectar" | "sincronizar"; step: EngineStep; text: string; done?: number; total?: number }
  | { kind: "listo_para_sincronizar"; prepared: PreparedSync }
  | { kind: "listo"; message: string; pending: PendingItem[]; model: string }
  | { kind: "bloqueado"; prepared: PreparedSync }
  | { kind: "error"; message: string; canPick: boolean; canRelease?: boolean };

/** Balanza que esta computadora usaba antes de "Mis balanzas" y que todavía no está registrada en la sucursal. */
const LOCAL_KEY = "__esta-computadora";

const CHOICE_FOR_TARGET: Record<ReturnType<typeof choiceForScale>, ScaleChoice> = { systel: "systel", "kretz-aura": "kretz-aura", "kretz-report": "kretz-report", "kretz-auto": "auto" };

export function MyScale({ products, branchId }: { products: EngineProduct[]; branchId: string | null }) {
  const { profile } = useAuth();
  const canManage = profile?.role === "owner" || profile?.role === "admin";
  const [scales, setScales] = useState<BranchScale[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "inicio" });
  const [replace, setReplace] = useState(false);
  const [newChoice, setNewChoice] = useState<ScaleChoice | null>(null);
  /** Al agregar: otra balanza registrada con el mismo número (solo se avisa). */
  const [lookalike, setLookalike] = useState<BranchScale | null>(null);
  /** El último reporte a soporte: llegó, no llegó, o todavía se está mandando (null). */
  const [reportSent, setReportSent] = useState<boolean | null>(null);
  /** El último diagnóstico, para verlo y descargarlo aunque el reporte no haya llegado. */
  const [lastDiagnostic, setLastDiagnostic] = useState<Record<string, unknown> | null>(null);
  const session = useRef<ScaleSession | null>(null);
  const ctxRef = useRef<BranchConnectResult | null>(null);

  const reload = useCallback(async () => {
    if (!branchId || !isSupabaseConfigured) {
      setLoaded(true);
      return;
    }
    try {
      setScales(await listBranchScales(branchId));
    } catch {
      // sin conexión: se muestra lo que se recuerda en esta computadora
    } finally {
      setLoaded(true);
    }
  }, [branchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () => () => {
      void session.current?.close();
    },
    []
  );

  // La balanza que esta PC ya usaba con "Mi balanza" (antes de la 133) y no está registrada: se muestra igual y se
  // registra sola la primera vez que pasa productos. Así los clientes que ya andan no tienen que hacer nada.
  const legacy = useMemo<BranchScale | null>(() => {
    const r = loadRememberedScale();
    if (!r || !loaded || scales.some((s) => s.family === r.family)) return null;
    return { key: LOCAL_KEY, name: r.label, family: r.family, brand: r.family, model: r.label, identity: {}, active: true, lastSeenAt: r.connectedAt, sellsWithCodes: false };
  }, [scales, loaded]);
  const list = legacy ? [...scales, legacy] : scales;
  const active = list.find((s) => s.key === activeKey) ?? null;

  // Los errores llegan a soporte con cualquier usuario: en el local suele estar abierta la sesión del cajero.
  /** El diagnóstico completo de un intento: lo mismo que va a soporte, y lo que se ve y se descarga en pantalla. */
  function buildDiagnostic(stage: string, technical: unknown, diag: ConnectDiag | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const info = session.current?.supportInfo() ?? {};
    const target = active ? { clave: active.key, nombre: active.name, marca: active.family, identidad: active.identity } : { nueva: newChoice };
    return {
      cuando: new Date().toISOString(),
      etapa: stage,
      mensaje: technical instanceof Error ? technical.message : String(technical),
      balanza: target,
      ...info,
      ...extra,
      tecnico: (technical as { technical?: string })?.technical ?? null,
      cable: diag?.usb ?? null,
      autorizados: diag?.authorized ?? [],
      pasos: diag?.steps ?? [],
      otras_pestanas: diag?.otherTabs ?? null,
      intercambio: diag?.log.slice(-200) ?? [],
      eventos: diag?.events.slice(-300) ?? []
    };
  }

  /** true si el reporte llegó (antes se decía "ya le llegó a soporte" aunque el servidor lo hubiera rechazado). */
  async function report(stage: string, technical: unknown, diag: ConnectDiag | null, extra: Record<string, unknown> = {}): Promise<boolean> {
    const full = buildDiagnostic(stage, technical, diag, extra);
    setLastDiagnostic(full);
    if (!profile || !isSupabaseConfigured) return false;
    try {
      await submitScaleSupportReport({
        note: `Mis balanzas (${active?.name ?? `nueva: ${newChoice ?? "?"}`}) · ${stage}: ${String(full.mensaje)}`.slice(0, 500),
        logText: JSON.stringify(full).slice(0, 60000),
        connections: [],
        branchId
      });
      return true;
    } catch {
      return false;
    }
  }

  function reportAndShow(...args: Parameters<typeof report>) {
    setReportSent(null);
    void report(...args).then(setReportSent);
  }

  async function closeSession() {
    await session.current?.close().catch(() => {});
    session.current = null;
  }

  /** target = balanza registrada (o la de esta PC); null = agregar una nueva con la marca elegida. */
  async function handleConnect(target: BranchScale | null, pick: boolean, choiceForNew: ScaleChoice | null = newChoice, allowSystelRelease = false) {
    setReplace(false);
    await closeSession();
    setActiveKey(target?.key ?? null);
    const progress = (step: EngineStep, text: string, done?: number, total?: number) => setPhase({ kind: "trabajando", stage: "conectar", step, text, done, total });
    progress("permiso", "Preparando…");
    const diag = emptyDiag();
    const choice: ScaleChoice = target ? CHOICE_FOR_TARGET[choiceForScale(target)] : choiceForNew ?? "auto";
    const isLegacy = target?.key === LOCAL_KEY;
    const remembered = loadRememberedScale();
    try {
      const result = await connectBranchScale(
        { branchId, products, online: isSupabaseConfigured, canManageLinks: canManage, diag, allowSystelRelease },
        progress,
        { target: isLegacy ? { ...target!, identity: {} } : target, known: scales, pick },
        {
          adapters: adaptersForChoice(choice),
          release: releaseSerialEverywhere,
          // La balanza de antes no tiene cable recordado por clave: se usa el que recordaba "Mi balanza".
          binding: isLegacy ? () => (remembered ? { branchId: branchId ?? "", family: remembered.family, usb: remembered.usb, snapshot: {}, lastOkAt: remembered.connectedAt } : null) : undefined
        }
      );
      session.current = result.session;
      ctxRef.current = result;
      setLookalike(result.lookalike);
      const key = await remember(result, target);
      if (key) setActiveKey(key);
      const prepared = await result.session.prepare(progress);
      // Mismo número y mismo cable que otra (real Los gringos): si imprime distinto que la tarjeta elegida, no es esa.
      const realTarget = target && target.key !== LOCAL_KEY ? target : null;
      if (realTarget) {
        const check = checkScaleFormats(realTarget, result.session.codeFormats?.() ?? null, scales);
        if (check.verdict === "otra") {
          setPhase({
            kind: "error",
            canPick: false,
            message: check.same
              ? `La balanza enchufada es "${check.same.name}", no "${realTarget.name}" (imprime los códigos como esa). Volvé a mis balanzas y tocá "PASAR PRODUCTOS" en "${check.same.name}". No se cambió nada.`
              : `La balanza enchufada no es "${realTarget.name}": imprime los códigos distinto. Si es otra balanza, volvé a mis balanzas y tocá "AGREGAR BALANZA". No se cambió nada.`
          });
          reportAndShow("conectar (otra balanza)", `imprime distinto que ${realTarget.key}`, diag, { formatos_leidos: result.session.codeFormats?.() ?? null, formatos_tarjeta: realTarget.formats ?? null });
          return;
        }
      }
      // La lectura pudo descubrir con qué señales o a qué número atiende la balanza: se vuelve a guardar su conexión.
      if (branchId && key) saveBinding(key, { branchId, family: result.family, usb: result.usb });
      if (prepared.blocker) setPhase({ kind: "bloqueado", prepared });
      else if (prepared.upToDate) setPhase({ kind: "listo", message: "¡Listo! Tu balanza está conectada y ya podés vender.", pending: prepared.pending, model: prepared.label });
      else setPhase({ kind: "listo_para_sincronizar", prepared });
    } catch (err) {
      const kind = friendlyKind(err);
      setPhase({ kind: "error", message: connectErrorMessage(err, choice), canPick: kind === "elegir_cable" || kind === "no_contesta" || kind === "otra_balanza", canRelease: kind === "balanza_ocupada" && !allowSystelRelease && canManage });
      reportAndShow("conectar", err, diag);
    }
  }

  /**
   * Después de conectar: registra la balanza en la sucursal (o actualiza su última conexión) y recuerda su cable en
   * esta computadora. Devuelve la clave registrada.
   */
  async function remember(result: BranchConnectResult, target: BranchScale | null): Promise<string | null> {
    const label = result.session.label;
    const realTarget = target && target.key !== LOCAL_KEY ? target : null;
    let key = realTarget?.key ?? (result.matched && result.matched.key !== LOCAL_KEY ? result.matched.key : null);
    if (branchId && isSupabaseConfigured && canManage) {
      try {
        key = await registerBranchScale(branchId, {
          key,
          name: key ? null : defaultScaleName(label, scales),
          family: result.family,
          brand: result.family,
          model: label,
          identity: result.identity
        });
      } catch {
        // sin la migración 134 o sin conexión: la balanza funciona igual; se registra la próxima vez
      }
    }
    // Las sesiones Systel guardan catálogo y vínculos con esta clave (antes era siempre "systel").
    if (key) {
      result.diag.steps.push(`registrada como ${key}`);
      result.ctx.scaleKey = key;
    }
    if (branchId) saveBinding(key ?? `${LOCAL_KEY}-${result.family}`, { branchId, family: result.family, usb: result.usb });
    rememberScale({ model: result.session.model, label, family: result.family, usb: result.usb, connectedAt: new Date().toISOString(), syncedAt: null });
    void reload();
    return key;
  }

  async function handleSync(prepared: PreparedSync) {
    const s = session.current;
    if (!s) return;
    const writes = prepared.writes + (replace ? prepared.pending.filter((p) => p.reason === "ocupado_en_balanza").length : 0);
    if (writes > 0) {
      const ok = window.confirm(
        `Patagonia va a actualizar ${writes} ${writes === 1 ? "producto" : "productos"} en ${active ? `"${active.name}"` : "tu balanza"}.\n\n` +
          "Antes guarda una copia de lo que tiene, y después comprueba cada producto uno por uno. No se borra nada.\n\n" +
          "Hacelo sin clientes esperando y no desenchufes la balanza hasta que termine. ¿Seguir?"
      );
      if (!ok) return;
    }
    const progress = (step: EngineStep, text: string, done?: number, total?: number) => setPhase({ kind: "trabajando", stage: "sincronizar", step, text, done, total });
    progress("sincronizar", "Preparando…");
    try {
      const out = await s.sync(prepared, progress, { allowReplace: replace });
      if (!out.ok) {
        setPhase({ kind: "error", message: out.message, canPick: false });
        reportAndShow("sincronizar (frenado)", out.message, ctxRef.current?.diag ?? null, out.support ?? {});
        return;
      }
      markSynced();
      setPhase({ kind: "listo", message: out.message, pending: out.pending, model: prepared.label });
      void reload();
    } catch (err) {
      setPhase({ kind: "error", message: friendlyMessage(err), canPick: false });
      reportAndShow("sincronizar", err, ctxRef.current?.diag ?? null);
    }
  }

  async function handleRename(s: BranchScale) {
    if (!branchId) return;
    const name = window.prompt("Nombre de la balanza (por ejemplo \"Mostrador\" o \"Balanza del fondo\"):", s.name)?.trim();
    if (!name || name === s.name) return;
    try {
      await renameBranchScale(branchId, s.key, name);
      await reload();
    } catch {
      window.alert("No se pudo cambiar el nombre. Revisá la conexión y probá de nuevo.");
    }
  }

  async function handleRemove(s: BranchScale) {
    if (!branchId) return;
    if (!window.confirm(`¿Quitar "${s.name}" de esta sucursal?\n\nMostrador deja de leer sus tickets. Las ventas ya hechas no cambian, y en la balanza no se borra nada. Si la volvés a agregar, se configura de nuevo.`)) return;
    try {
      await removeBranchScale(branchId, s.key);
      forgetBinding(s.key, branchId);
      if (activeKey === s.key) backToList();
      await reload();
    } catch {
      window.alert("No se pudo quitar la balanza. Revisá la conexión y probá de nuevo.");
    }
  }

  function backToList() {
    void closeSession();
    setActiveKey(null);
    setNewChoice(null);
    setPhase({ kind: "inicio" });
  }

  const working = phase.kind === "trabajando";
  const showList = phase.kind === "inicio";

  return (
    <section className="my-scale">
      <div className="my-scale-head">
        <div className="my-scale-icon"><Scale size={22} /></div>
        <div>
          <h2>{showList ? "Mis balanzas" : active ? active.name : newChoice ? `Agregar ${choiceLabel(newChoice)}` : "Agregar balanza"}</h2>
          <p className="muted">{showList ? "Conectá cada balanza una vez y vendé escaneando el ticket." : "Seguí los pasos en pantalla."}</p>
        </div>
      </div>

      {showList && (
        <div className="my-scale-body">
          {loaded && list.length === 0 && <p className="my-scale-status">Todavía no agregaste ninguna balanza.</p>}
          {list.length > 0 && (
            <ul className="my-scale-list">
              {list.map((s) => {
                const local = s.key === LOCAL_KEY ? (loadRememberedScale()?.connectedAt ?? null) : branchId ? (bindingFor(s.key, branchId)?.lastOkAt ?? null) : null;
                const st = scaleStatus({ active: s.active, sellsWithCodes: s.sellsWithCodes, localOkAt: local });
                return (
                  <li key={s.key} className="my-scale-item">
                    <div>
                      <strong>{s.name}</strong>
                      <span className="muted"> · {s.model ?? (s.family === "kretz" ? "Kretz" : "Systel")}</span>
                      <p className={`my-scale-item-status ${st.tone}`}>{st.text}</p>
                    </div>
                    <div className="my-scale-actions">
                      <button className="my-scale-primary" onClick={() => void handleConnect(s, false)}>PASAR PRODUCTOS</button>
                      {canManage && s.key !== LOCAL_KEY && <button className="secondary" onClick={() => void handleRename(s)}>Cambiar nombre</button>}
                      {canManage && s.key !== LOCAL_KEY && <button className="secondary" onClick={() => void handleRemove(s)}>Quitar</button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {canManage ? (
            <button className={list.length === 0 ? "my-scale-primary" : "secondary"} onClick={() => setPhase({ kind: "elegir_marca" })}>
              <Plus size={16} /> AGREGAR BALANZA
            </button>
          ) : (
            list.length === 0 && <p className="muted">Para agregar una balanza tiene que entrar el dueño o un administrador.</p>
          )}
        </div>
      )}

      {phase.kind === "elegir_marca" && (
        <div className="my-scale-body">
          <p className="my-scale-status">¿Qué balanza vas a agregar?</p>
          <p className="muted">La marca está adelante o en la etiqueta de atrás de la balanza. Enchufala a esta computadora por el cable USB y prendela.</p>
          <div className="my-scale-choices">
            {SCALE_CHOICES.map((c) => (
              <button
                key={c.id}
                className="my-scale-choice"
                // La lista de cables de Chrome se abre con este mismo click.
                onClick={() => handleConnectNew(c.id)}
              >
                <strong>{c.label}</strong>
                <span>{c.hint}</span>
              </button>
            ))}
          </div>
          <button className="secondary" onClick={backToList}>Volver</button>
        </div>
      )}

      {working && (
        <div className="my-scale-body" aria-live="polite">
          <p className="my-scale-status">{phase.stage === "conectar" ? "Conectando tu balanza…" : "Sincronizando…"}</p>
          <div className="my-scale-bar" role="progressbar" aria-valuemin={0} aria-valuemax={phase.total ?? 100} aria-valuenow={phase.done ?? undefined}>
            <div style={phase.done && phase.total ? { width: `${Math.round((phase.done / phase.total) * 100)}%` } : undefined} className={phase.done && phase.total ? "" : "indeterminate"} />
          </div>
          <p className="muted">
            {phase.text}
            {phase.done && phase.total ? ` (${phase.done} de ${phase.total})` : ""}
          </p>
          {phase.stage === "sincronizar" && <p className="my-scale-warning">No desenchufes la balanza ni cierres esta pantalla.</p>}
        </div>
      )}

      {phase.kind === "listo_para_sincronizar" && (
        <div className="my-scale-body">
          <p className="my-scale-status">Tu balanza está lista para sincronizar</p>
          <p className="muted">{phase.prepared.label} conectada.</p>
          <div className="my-scale-facts">
            <Fact value={phase.prepared.ready} label="productos listos" />
            {phase.prepared.writes > 0 && <Fact value={phase.prepared.writes} label="para actualizar en la balanza" />}
            {phase.prepared.newLinks > 0 && <Fact value={phase.prepared.newLinks} label="reconocidos solos" />}
            {phase.prepared.pending.length > 0 && <Fact value={phase.prepared.pending.length} label="para revisar" tone="warn" />}
          </div>
          {phase.prepared.pending.some((p) => p.reason === "ocupado_en_balanza") && (
            <label className="my-scale-check">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              <span>En la balanza, {phase.prepared.pending.filter((p) => p.reason === "ocupado_en_balanza").length} números tienen otro producto. Reemplazarlos por los de Patagonia.</span>
            </label>
          )}
          <Notes notes={phase.prepared.notes} />
          {lookalike && (
            <p className="my-scale-warning">
              Se agregó como una balanza nueva. En esta sucursal ya está "{lookalike.name}", que contesta con el mismo número. Si las dos se conectan a la misma computadora, cambiale el número a una en su menú; si no, no hace falta nada.
            </p>
          )}
          <div className="my-scale-actions">
            <button className="my-scale-primary" onClick={() => void handleSync(phase.prepared)}>SINCRONIZAR PRODUCTOS</button>
            <button className="secondary" onClick={backToList}>Volver a mis balanzas</button>
          </div>
        </div>
      )}

      {phase.kind === "bloqueado" && (
        <div className="my-scale-body">
          <p className="my-scale-status"><TriangleAlert size={20} /> Falta un paso en la balanza</p>
          <p>{phase.prepared.blocker}</p>
          <div className="my-scale-actions">
            <button className="secondary" onClick={() => void handleConnect(active, false)}>Conectar otra vez</button>
            <button className="secondary" onClick={backToList}>Volver a mis balanzas</button>
          </div>
        </div>
      )}

      {phase.kind === "listo" && (
        <div className="my-scale-body">
          <p className="my-scale-status ok"><CheckCircle2 size={22} /> {phase.message}</p>
          <p className="muted">Pesá, imprimí el ticket y escanealo en Mostrador.</p>
          {phase.pending.length > 0 && active && <PendingReview items={phase.pending} products={products} branchId={branchId} scaleKey={active.key} />}
          <div className="my-scale-actions">
            <button className="secondary" onClick={() => void handleConnect(active, false)}>Volver a sincronizar</button>
            <button className="secondary" onClick={backToList}>Volver a mis balanzas</button>
          </div>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="my-scale-body">
          <p className="my-scale-status bad"><TriangleAlert size={20} /> {phase.message}</p>
          <div className="my-scale-actions">
            {active ? (
              <>
                <button className="my-scale-primary" onClick={() => void handleConnect(active, false)}>PROBAR DE NUEVO</button>
                {phase.canPick && <button className="secondary" onClick={() => void handleConnect(active, true)}>Elegir el cable</button>}
                {phase.canRelease && (
                  <button
                    className="secondary"
                    onClick={() => {
                      const ok = window.confirm(
                        "Patagonia va a mandarle a la balanza el comando oficial de Systel \"liberar el equipo\" (función 25).\n\n" +
                          "Según Systel, solo marca sus datos como sincronizados y la libera si quedó esperando a la PC al prenderse. No cambia productos, precios ni configuración.\n\n¿Seguir?"
                      );
                      if (ok) void handleConnect(active, false, newChoice, true);
                    }}
                  >
                    Intentar liberar la balanza
                  </button>
                )}
              </>
            ) : (
              newChoice && <button className="my-scale-primary" onClick={() => void handleConnectNew(newChoice)}>PROBAR DE NUEVO</button>
            )}
            <button className="secondary" onClick={backToList}>Volver a mis balanzas</button>
          </div>
          <p className="muted">
            {reportSent === null ? "Mandando el detalle técnico a soporte de Patagonia…" : reportSent ? "El detalle técnico ya le llegó a soporte de Patagonia." : "No se pudo mandar el detalle técnico a soporte: descargalo y mandalo por WhatsApp."}
          </p>
          {lastDiagnostic && <DiagnosticView diagnostic={lastDiagnostic} />}
        </div>
      )}
    </section>
  );

  function handleConnectNew(choice: ScaleChoice) {
    setNewChoice(choice);
    void handleConnect(null, true, choice);
  }
}

/** El error al conectar, nombrando la balanza que eligió el cliente y qué revisar en ESA balanza. */
function connectErrorMessage(err: unknown, choice: ScaleChoice | null): string {
  if (friendlyKind(err) !== "no_contesta" || !choice || choice === "auto") return friendlyMessage(err);
  const label = choiceLabel(choice);
  const check = choice === "kretz-aura" ? "el cable enchufado y, en el menú de la balanza, COMUNI → MODO \"Datos\"" : "el cable USB enchufado y que no esté abierto el programa de la balanza";
  return `Tu ${label} no contestó. Revisá que esté prendida, ${check}, y probá de nuevo.`;
}

interface ExchangeRow {
  step: string;
  tx: string;
  rx: string;
  rxText: string;
  ms: number;
  result: string;
}

/** "Ver diagnóstico" y "Descargar diagnóstico": lo que se mandó y lo que contestó la balanza, pedido por pedido. */
function DiagnosticView({ diagnostic }: { diagnostic: Record<string, unknown> }) {
  const rows = [...((diagnostic.intercambio as ExchangeRow[] | undefined) ?? []), ...((diagnostic.intercambio_sesion as ExchangeRow[] | undefined) ?? [])];
  function download() {
    const blob = new Blob([JSON.stringify(diagnostic, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diagnostico-balanza-${String(diagnostic.cuando ?? "").slice(0, 16).replace(/[:T]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <details className="my-scale-review">
      <summary>Ver diagnóstico ({rows.length} pedidos)</summary>
      <div className="my-scale-actions">
        <button className="secondary" onClick={download}>Descargar diagnóstico</button>
      </div>
      <div className="my-scale-diag">
        <table>
          <thead>
            <tr><th>Paso</th><th>Mandado</th><th>Recibido</th><th>Texto</th><th>ms</th><th>Resultado</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.step}</td>
                <td><code>{r.tx}</code></td>
                <td><code>{r.rx || "—"}</code></td>
                <td>{r.rxText}</td>
                <td>{r.ms}</td>
                <td>{r.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Fact({ value, label, tone }: { value: number; label: string; tone?: "warn" }) {
  return (
    <div className={`my-scale-fact${tone ? ` ${tone}` : ""}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <ul className="my-scale-notes">
      {notes.map((n) => <li key={n}>{n}</li>)}
    </ul>
  );
}

const REASON_TEXT: Record<PendingItem["reason"], string> = {
  codigo_de_otro_producto: "el número es de otro producto en Patagonia",
  forma_de_venta: "en la balanza y en Patagonia se venden distinto (kilo / unidad)",
  sin_producto: "no está en Patagonia",
  nombre_parecido: "hay uno parecido",
  varios_candidatos: "hay varios parecidos",
  codigo_duplicado_en_patagonia: "ese número está repetido en Patagonia",
  producto_desactivado: "estaba unido a un producto que ya no está activo",
  ocupado_en_balanza: "en la balanza ese número es de otro producto"
};

/**
 * Lo que no se pudo reconocer solo. Se decide acá una vez (nunca en la caja): qué producto de Patagonia es,
 * cobrarlo sin descontar stock, o no venderlo. Solo para las balanzas que imprimen su propio número (Systel).
 */
function PendingReview({ items, products, branchId, scaleKey }: { items: PendingItem[]; products: EngineProduct[]; branchId: string | null; scaleKey: string }) {
  const reviewable = items.filter((i) => i.reason !== "ocupado_en_balanza");
  const [choice, setChoice] = useState<Record<number, string>>(() => Object.fromEntries(reviewable.filter((i) => i.suggestionId).map((i) => [i.code, i.suggestionId!])));
  const [saved, setSaved] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = products.filter((p) => p.active ?? true);
  const left = reviewable.filter((i) => !saved[i.code]);

  async function save(item: PendingItem) {
    const v = choice[item.code];
    if (!v || !branchId) return;
    setBusy(true);
    setError("");
    try {
      await setScaleLinks(branchId, scaleKey, [v === "libre" ? { code: item.code, kind: "libre", productId: null } : v === "none" ? { code: item.code, kind: "none", productId: null } : { code: item.code, kind: "product", productId: v }]);
      setSaved({ ...saved, [item.code]: true });
    } catch {
      setError("No se pudo guardar. Revisá la conexión y probá de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  if (reviewable.length === 0) return null;
  return (
    <details className="my-scale-review" open={left.length > 0 && left.length <= 5}>
      <summary>{left.length === 0 ? "Todos los productos revisados" : `${left.length} ${left.length === 1 ? "producto para revisar" : "productos para revisar"}`}</summary>
      {error && <p className="my-scale-warning">{error}</p>}
      {left.map((item) => {
        const options = active.filter((p) => (p.unit === "kg") === item.byWeight);
        return (
          <div key={item.code} className="my-scale-review-row">
            <div>
              <strong>{item.scaleName}</strong>
              <span className="muted"> · {REASON_TEXT[item.reason]}</span>
            </div>
            <select value={choice[item.code] ?? ""} disabled={busy} onChange={(e) => setChoice({ ...choice, [item.code]: e.target.value })} aria-label={`Qué es ${item.scaleName}`}>
              <option value="">¿Qué producto es?</option>
              {options.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
              <option value="libre">Cobrarlo sin descontar stock</option>
              <option value="none">No se vende</option>
            </select>
            <button className="secondary" disabled={busy || !choice[item.code]} onClick={() => void save(item)}>Guardar</button>
          </div>
        );
      })}
    </details>
  );
}
