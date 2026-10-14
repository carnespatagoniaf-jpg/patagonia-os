import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Scale, TriangleAlert } from "lucide-react";
import { isSupabaseConfigured } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { connectScale, markSynced } from "./engine/engine";
import { SCALE_ADAPTERS } from "./engine/live";
import { friendlyMessage } from "./engine/friendly";
import { forgetRememberedScale, loadRememberedScale } from "./engine/memory";
import type { EngineProduct, EngineStep, PendingItem, PreparedSync, ScaleSession } from "./engine/types";
import { setScaleLinks } from "./sale/scale-sale-service";
import { submitScaleSupportReport } from "./support-service";

/**
 * "Mi balanza": la única pantalla de balanza que ve el cliente.
 *
 *   1. Conectar      → permiso, buscar, identificar, leer y comparar (sin un solo dato técnico)
 *   2. Sincronizar   → respaldo, escritura comprobada, relectura, guardado en Patagonia
 *   3. Vender        → Mostrador lee los tickets
 *
 * Todo lo técnico (puertos, velocidades, diagnósticos, escritura experimental, restauraciones) está en
 * "Herramientas técnicas" (ScaleSupportTools), solo para soporte.
 */

type Phase =
  | { kind: "inicio" }
  | { kind: "trabajando"; stage: "conectar" | "sincronizar"; step: EngineStep; text: string; done?: number; total?: number }
  | { kind: "listo_para_sincronizar"; prepared: PreparedSync }
  | { kind: "listo"; message: string; pending: PendingItem[]; model: string }
  | { kind: "bloqueado"; prepared: PreparedSync }
  | { kind: "error"; message: string };

export function MyScale({ products, branchId }: { products: EngineProduct[]; branchId: string | null }) {
  const { profile } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: "inicio" });
  const [replace, setReplace] = useState(false);
  const session = useRef<ScaleSession | null>(null);
  const remembered = loadRememberedScale();
  const canReport = profile?.role === "owner" || profile?.role === "admin";
  const ctx = useMemo(() => ({ branchId, products, online: isSupabaseConfigured, canManageLinks: canReport }), [branchId, products, canReport]);

  useEffect(
    () => () => {
      void session.current?.close();
    },
    []
  );

  async function report(stage: string, technical: unknown, extra: Record<string, unknown> = {}) {
    if (!canReport || !isSupabaseConfigured) return;
    try {
      const info = session.current?.supportInfo() ?? {};
      await submitScaleSupportReport({
        note: `Mi balanza · ${stage}: ${technical instanceof Error ? technical.message : String(technical)}`.slice(0, 500),
        logText: JSON.stringify({ ...info, ...extra, tecnico: (technical as { technical?: string })?.technical ?? null }).slice(0, 20000),
        connections: [],
        branchId
      });
    } catch {
      // si no llega, el cliente igual ve un mensaje claro
    }
  }

  async function handleConnect() {
    setReplace(false);
    await session.current?.close();
    session.current = null;
    const progress = (step: EngineStep, text: string, done?: number, total?: number) => setPhase({ kind: "trabajando", stage: "conectar", step, text, done, total });
    progress("permiso", "Preparando…");
    try {
      const s = await connectScale(ctx, progress, { adapters: SCALE_ADAPTERS });
      session.current = s;
      const prepared = await s.prepare(progress);
      if (prepared.blocker) setPhase({ kind: "bloqueado", prepared });
      else if (prepared.upToDate) setPhase({ kind: "listo", message: "¡Listo! Tu balanza está conectada y ya podés vender.", pending: prepared.pending, model: prepared.label });
      else setPhase({ kind: "listo_para_sincronizar", prepared });
    } catch (err) {
      setPhase({ kind: "error", message: friendlyMessage(err) });
      void report("conectar", err);
    }
  }

  async function handleSync(prepared: PreparedSync) {
    const s = session.current;
    if (!s) return;
    const writes = prepared.writes + (replace ? prepared.pending.filter((p) => p.reason === "ocupado_en_balanza").length : 0);
    if (writes > 0) {
      const ok = window.confirm(
        `Patagonia va a actualizar ${writes} ${writes === 1 ? "producto" : "productos"} en tu balanza.\n\n` +
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
        setPhase({ kind: "error", message: out.message });
        void report("sincronizar (frenado)", out.message, out.support ?? {});
        return;
      }
      markSynced();
      setPhase({ kind: "listo", message: out.message, pending: out.pending, model: prepared.label });
    } catch (err) {
      setPhase({ kind: "error", message: friendlyMessage(err) });
      void report("sincronizar", err);
    }
  }

  function useAnother() {
    forgetRememberedScale();
    void session.current?.close();
    session.current = null;
    setPhase({ kind: "inicio" });
  }

  const stepIndex = phase.kind === "inicio" || (phase.kind === "trabajando" && phase.stage === "conectar") || phase.kind === "error" ? 0 : phase.kind === "listo" ? 2 : 1;

  return (
    <section className="my-scale">
      <div className="my-scale-head">
        <div className="my-scale-icon"><Scale size={22} /></div>
        <div>
          <h2>Mi balanza</h2>
          <p className="muted">{remembered && phase.kind === "inicio" ? `${remembered.label}${remembered.syncedAt ? " · ya configurada en esta computadora" : ""}` : "Conectala una vez y vendé escaneando el ticket."}</p>
        </div>
      </div>

      <ol className="my-scale-steps" aria-label="Pasos">
        {["Conectar", "Sincronizar", "Vender"].map((label, i) => (
          <li key={label} className={i < stepIndex ? "done" : i === stepIndex ? "current" : ""}>
            <span>{i < stepIndex ? "✓" : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {phase.kind === "inicio" && (
        <div className="my-scale-body">
          <p className="my-scale-status">{remembered ? "Conectá tu balanza para seguir trabajando." : "Conectá tu balanza para empezar a trabajar."}</p>
          <p className="muted">Enchufala a esta computadora por el cable USB y prendela.</p>
          <button className="my-scale-primary" onClick={() => void handleConnect()}>CONECTAR BALANZA</button>
        </div>
      )}

      {phase.kind === "trabajando" && (
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
          <button className="my-scale-primary" onClick={() => void handleSync(phase.prepared)}>SINCRONIZAR PRODUCTOS</button>
        </div>
      )}

      {phase.kind === "bloqueado" && (
        <div className="my-scale-body">
          <p className="my-scale-status"><TriangleAlert size={20} /> Falta un paso en la balanza</p>
          <p>{phase.prepared.blocker}</p>
          <button className="secondary" onClick={() => void handleConnect()}>Conectar balanza otra vez</button>
        </div>
      )}

      {phase.kind === "listo" && (
        <div className="my-scale-body">
          <p className="my-scale-status ok"><CheckCircle2 size={22} /> {phase.message}</p>
          <p className="muted">Pesá, imprimí el ticket y escanealo en Mostrador.</p>
          {phase.pending.length > 0 && <PendingReview items={phase.pending} products={products} branchId={branchId} />}
          <div className="my-scale-actions">
            <button className="secondary" onClick={() => void handleConnect()}>Volver a sincronizar</button>
          </div>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="my-scale-body">
          <p className="my-scale-status bad"><TriangleAlert size={20} /> {phase.message}</p>
          <div className="my-scale-actions">
            <button className="my-scale-primary" onClick={() => void handleConnect()}>PROBAR DE NUEVO</button>
            {remembered && <button className="secondary" onClick={useAnother}>Usar otra balanza</button>}
          </div>
        </div>
      )}
    </section>
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
function PendingReview({ items, products, branchId }: { items: PendingItem[]; products: EngineProduct[]; branchId: string | null }) {
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
      await setScaleLinks(branchId, "systel", [v === "libre" ? { code: item.code, kind: "libre", productId: null } : v === "none" ? { code: item.code, kind: "none", productId: null } : { code: item.code, kind: "product", productId: v }]);
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
