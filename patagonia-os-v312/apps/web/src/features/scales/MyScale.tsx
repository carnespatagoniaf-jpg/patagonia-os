import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Plus, Scale, TriangleAlert } from "lucide-react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { releaseSerialEverywhere } from "../inventory/kretz/serial-tabs";
import { connectBranchScale, type BranchConnectResult } from "./engine/connect-branch";
import { isPhoneOrTablet, PHONE_OR_TABLET_MESSAGE } from "./engine/device";
import { markSynced } from "./engine/engine";
import { adaptersForChoice } from "./engine/live";
import { ALREADY_SAME, friendlyKind, friendlyMessage } from "./engine/friendly";
import { choiceLabel, SCALE_CHOICES, type ScaleChoice } from "./engine/choice";
import { loadRememberedScale, rememberScale } from "./engine/memory";
import { emptyDiag, type ConnectDiag, type EngineProduct, type EngineStep, type PendingItem, type PreparedSync, type ProductProblem, type ScaleSession } from "./engine/types";
import { checkScaleFormats, choiceForScale, defaultScaleName, listBranchScales, registerBranchScale, removeBranchScale, renameBranchScale, saveScaleInstall, scaleStatus, type BranchScale } from "./registry/branch-scales";
import { installSteps, installSummary, localInstall, newestInstall, saveLocalInstall, type InstallRecord } from "./install-status";
import { bindingFor, forgetBinding, saveBinding } from "./registry/local-bindings";
import { setScaleLinks } from "./sale/scale-sale-service";
import { compactSupportLog } from "./support-compact";
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
  | { kind: "listo"; message: string; pending: PendingItem[]; model: string; skipped?: ProductProblem[] }
  | { kind: "bloqueado"; prepared: PreparedSync }
  | { kind: "error"; message: string; canPick: boolean; canRelease?: boolean; failures?: ProductProblem[] };

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
  /** Para volver a dibujar los pasos después de guardar uno en esta computadora. */
  const [, setInstallTick] = useState(0);
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
      // Qué web tenía y qué balanzas tiene registradas la sucursal: sin esto no se sabía si el arreglo ya le había llegado.
      version: typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : null,
      balanzas_sucursal: scales.map((s) => ({ clave: s.key, nombre: s.name, marca: s.family, modelo: s.model, identidad: s.identity, activa: s.active, vende_con_codigos: s.sellsWithCodes })),
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
        logText: compactSupportLog(full),
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

  /** Paso comprobado de la instalación: en esta computadora y en la ficha de la balanza (si la base la tiene). */
  function recordInstall(key: string | null | undefined, patch: InstallRecord) {
    if (!branchId || !key) return;
    saveLocalInstall(branchId, key, patch);
    if (key !== LOCAL_KEY && isSupabaseConfigured) void saveScaleInstall(branchId, key, patch).catch(() => {});
    setInstallTick((t) => t + 1);
  }

  /** Lo comprobado de una balanza: lo más nuevo entre esta computadora y su ficha. */
  function installOf(s: BranchScale | null): InstallRecord {
    if (!s || !branchId) return {};
    return newestInstall(localInstall(branchId, s.key), s.install ?? null);
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
      const at = new Date().toISOString();
      recordInstall(key, {
        model: prepared.label,
        detectedAt: at,
        communicationAt: at,
        // "Ya está igual" sale de releer cada producto de la balanza: cuenta como enviado y comprobado.
        ...(prepared.upToDate ? { sentAt: at, sentCount: prepared.ready, verifiedAt: at, verifiedCount: prepared.ready, failedCount: 0 } : {})
      });
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
      if (prepared.blocker) {
        setPhase({ kind: "bloqueado", prepared });
        // Frenada por la balanza (modelo no comprobado o lectura incompleta), no por permisos: va sola a soporte. Antes
        // no se mandaba nada y no se sabía qué balanza era (real Giuseppe, 27/10).
        if (!prepared.canWrite) reportAndShow("frenada", prepared.blocker, diag, { modelo_detectado: prepared.label, formatos_leidos: result.session.codeFormats?.() ?? null, notas: prepared.notes });
      } else if (prepared.upToDate) setPhase({ kind: "listo", message: ALREADY_SAME, pending: prepared.pending, model: prepared.label, skipped: prepared.skipped });
      else setPhase({ kind: "listo_para_sincronizar", prepared });
    } catch (err) {
      const kind = friendlyKind(err);
      setPhase({ kind: "error", message: connectErrorMessage(err, choice), canPick: kind === "elegir_cable" || kind === "no_contesta" || kind === "otra_balanza", canRelease: kind === "balanza_ocupada" && !allowSystelRelease && canManage });
      recordInstall(target?.key, { lastError: friendlyMessage(err).slice(0, 200), lastErrorAt: new Date().toISOString() });
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
      const at = new Date().toISOString();
      if (!out.ok) {
        recordInstall(activeKey, { sentAt: at, sentCount: prepared.ready + out.verified, verifiedAt: at, verifiedCount: prepared.ready + out.verified, failedCount: Math.max(out.failures?.length ?? 0, 1), lastError: out.message.slice(0, 200), lastErrorAt: at });
        setPhase({ kind: "error", message: out.message, canPick: false, failures: out.failures });
        reportAndShow("sincronizar (frenado)", out.message, ctxRef.current?.diag ?? null, out.support ?? {});
        return;
      }
      markSynced();
      recordInstall(activeKey, { sentAt: at, sentCount: prepared.ready + out.verified, verifiedAt: at, verifiedCount: prepared.ready + out.verified, failedCount: 0 });
      setPhase({ kind: "listo", message: out.message, pending: out.pending, model: prepared.label, skipped: prepared.skipped });
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

  const onPhoneOrTablet = isPhoneOrTablet();
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

      {onPhoneOrTablet && (showList || phase.kind === "elegir_marca") && <p className="my-scale-warning">{PHONE_OR_TABLET_MESSAGE}</p>}

      {showList && (
        <div className="my-scale-body">
          {loaded && list.length === 0 && <p className="my-scale-status">Todavía no agregaste ninguna balanza.</p>}
          {list.length > 0 && (
            <ul className="my-scale-list">
              {list.map((s) => {
                const local = s.key === LOCAL_KEY ? (loadRememberedScale()?.connectedAt ?? null) : branchId ? (bindingFor(s.key, branchId)?.lastOkAt ?? null) : null;
                const inst = installOf(s);
                const st = inst.detectedAt && !(s.sellsWithCodes && !s.active) ? installSummary(inst) : scaleStatus({ active: s.active, sellsWithCodes: s.sellsWithCodes, localOkAt: local });
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
          <ProblemList title="no van a la balanza" items={phase.prepared.skipped} />
          <ProblemList title="van con el nombre acortado" items={phase.prepared.warnings} />
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
          {!phase.prepared.canWrite && (
            <p className="muted">
              {reportSent === null ? "Mandando el detalle técnico a soporte de Patagonia…" : reportSent ? "El detalle técnico ya le llegó a soporte de Patagonia." : "No se pudo mandar el detalle técnico a soporte: descargalo y mandalo por WhatsApp."}
            </p>
          )}
          {!phase.prepared.canWrite && lastDiagnostic && <DiagnosticView diagnostic={lastDiagnostic} />}
        </div>
      )}

      {phase.kind === "listo" && (
        <div className="my-scale-body">
          <p className="my-scale-status ok"><CheckCircle2 size={22} /> {phase.message}</p>
          <InstallChecklist record={installOf(active)} onRefresh={() => void reload()} />
          {phase.pending.length > 0 && active && <PendingReview items={phase.pending} products={products} branchId={branchId} scaleKey={active.key} />}
          <ProblemList title="no van a la balanza" items={phase.skipped} />
          <div className="my-scale-actions">
            <button className="secondary" onClick={() => void handleConnect(active, false)}>Volver a sincronizar</button>
            <button className="secondary" onClick={backToList}>Volver a mis balanzas</button>
          </div>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="my-scale-body">
          <p className="my-scale-status bad"><TriangleAlert size={20} /> {phase.message}</p>
          <ProblemList title="no quedaron bien en la balanza" items={phase.failures} open />
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

/** Los 5 pasos de la instalación, cada uno con lo que lo prueba (install-status.ts). */
function InstallChecklist({ record, onRefresh }: { record: InstallRecord; onRefresh: () => void }) {
  const steps = installSteps(record);
  return (
    <div className="my-scale-steps">
      <ol>
        {steps.map((s) => (
          <li key={s.id} className={s.done ? "ok" : "todo"}>
            {s.done ? <CheckCircle2 size={18} /> : <span className="my-scale-step-dot" />}
            <div>
              <strong>{s.label}</strong>
              <span className="muted">{s.detail}</span>
            </div>
          </li>
        ))}
      </ol>
      {!steps[4].done && (
        <div className="my-scale-actions">
          <button className="secondary" onClick={onRefresh}>Ya escaneé una etiqueta: comprobar</button>
        </div>
      )}
    </div>
  );
}

/** El error al conectar, nombrando la balanza que eligió el cliente y qué revisar en ESA balanza. */
function connectErrorMessage(err: unknown, choice: ScaleChoice | null): string {
  // Desde la tablet la lista de cables sale vacía y el cliente la cierra: el motivo real es el aparato, no la elección.
  if (isPhoneOrTablet() && (friendlyKind(err) === "sin_eleccion" || friendlyKind(err) === "sin_navegador")) return PHONE_OR_TABLET_MESSAGE;
  if (friendlyKind(err) !== "no_contesta" || !choice || choice === "auto") return friendlyMessage(err);
  const label = choiceLabel(choice);
  if (choice === "kretz-report") {
    // Manual Kretz Report NX/LT: la LT va por Bluetooth o USB (sin adaptador), la NX por red. No usa adaptador USB a serie (DB9).
    return `Tu ${label} no contestó. La Report LT se conecta por Bluetooth (emparejala en Windows y elegí "Puerto serie estándar a través de vínculo Bluetooth") o con su cable USB directo, no con un adaptador USB a serie DB9. La Report NX va por red: escribinos. Revisá también que no esté abierto iTegra.`;
  }
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

/** Cada producto que no se mandó o no quedó bien, con el motivo: el cliente tiene que poder ver cuál es y arreglarlo. */
function ProblemList({ title, items, open = false }: { title: string; items?: ProductProblem[]; open?: boolean }) {
  if (!items?.length) return null;
  return (
    <details className="my-scale-problems" open={open}>
      <summary>{items.length === 1 ? `1 producto ${title.replace(/^no van/, "no va").replace(/^no quedaron/, "no quedó")}` : `${items.length} productos ${title}`}</summary>
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
