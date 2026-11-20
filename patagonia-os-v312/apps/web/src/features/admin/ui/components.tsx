import { useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, Monitor, Moon, Sun, X, XCircle, type LucideIcon } from "lucide-react";
import { BRAND } from "../../../lib/brand";
import { useAdminTheme, type ThemeChoice } from "./theme";

export type Tone = "ok" | "warn" | "danger" | "info" | "brand" | "neutral";

// ── Botón ────────────────────────────────────────────────

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "whatsapp";
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
  /** Muestra la ruedita y deshabilita el botón mientras se guarda. */
  loading?: boolean;
  block?: boolean;
};

export function Button({ variant = "primary", size = "md", icon: Icon, loading, block, className = "", children, disabled, type = "button", ...rest }: ButtonProps) {
  const cls = ["pa-btn", `pa-btn-${variant}`, size !== "md" ? `pa-btn-${size}` : "", block ? "pa-btn-block" : "", className].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="pa-spin" aria-hidden /> : Icon ? <Icon size={size === "sm" ? 14 : 16} aria-hidden /> : null}
      {children}
    </button>
  );
}

// ── Campos ───────────────────────────────────────────────

type FieldProps = { label: string; hint?: string; error?: string; children: (id: string, describedBy?: string) => ReactNode };

/** Rótulo + campo + ayuda/error, siempre igual. */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const noteId = hint || error ? `${id}-note` : undefined;
  return (
    <div className="pa-field">
      <label className="pa-field-label" htmlFor={id}>{label}</label>
      {children(id, noteId)}
      {error ? <span id={noteId} className="pa-field-error">{error}</span> : hint ? <span id={noteId} className="pa-field-hint">{hint}</span> : null}
    </div>
  );
}

export function Input({ className = "", invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={`pa-input ${className}`.trim()} aria-invalid={invalid || undefined} {...rest} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`pa-input ${className}`.trim()} {...rest}>{children}</select>;
}

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`pa-input ${className}`.trim()} {...rest} />;
}

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="pa-check">
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

// ── Tarjetas y números ──────────────────────────────────

export function Card({ title, subtitle, actions, children, className = "" }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={`pa-card ${className}`.trim()}>
      {(title || actions) && (
        <div className="pa-card-head">
          <div>
            {title && <h2 className="pa-card-title">{title}</h2>}
            {subtitle && <p className="pa-card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="pa-form-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Un número clave. `delta` = variación en % contra el período anterior; `goodWhenUp=false` para números donde
 * subir es malo (deuda, bajas).
 */
export function Kpi({ label, value, delta, deltaLabel, goodWhenUp = true, hint }: { label: string; value: ReactNode; delta?: number | null; deltaLabel?: string; goodWhenUp?: boolean; hint?: ReactNode }) {
  const hasDelta = delta !== undefined && delta !== null && Number.isFinite(delta);
  const good = hasDelta && (delta! === 0 || (delta! > 0) === goodWhenUp);
  return (
    <div className="pa-kpi">
      <span className="pa-kpi-label">{label}</span>
      <strong className="pa-kpi-value">{value}</strong>
      {hasDelta && (
        <span className={`pa-kpi-delta ${good ? "up" : "down"}`}>
          {delta! > 0 ? "▲" : delta! < 0 ? "▼" : "="} {Math.abs(delta!)}%{deltaLabel ? ` ${deltaLabel}` : ""}
        </span>
      )}
      {hint && <span className="pa-kpi-hint">{hint}</span>}
    </div>
  );
}

export function Badge({ tone = "neutral", dot = true, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return <span className={`pa-badge ${tone === "neutral" ? "" : tone} ${dot ? "" : "plain"}`.replace(/\s+/g, " ").trim()}>{children}</span>;
}

// ── Avisos ───────────────────────────────────────────────

const ALERT_ICON: Record<Exclude<Tone, "brand" | "neutral">, LucideIcon> = { ok: CheckCircle2, warn: AlertTriangle, danger: XCircle, info: Info };

export function Alert({ tone = "info", title, children, action, onClose }: { tone?: "ok" | "warn" | "danger" | "info"; title?: ReactNode; children?: ReactNode; action?: ReactNode; onClose?: () => void }) {
  const Icon = ALERT_ICON[tone];
  return (
    <div className={`pa-alert ${tone}`} role={tone === "danger" || tone === "warn" ? "alert" : "status"}>
      <Icon size={18} aria-hidden style={{ marginTop: 2 }} />
      <div className="pa-alert-body">
        {title && <span className="pa-alert-title">{title}</span>}
        {children && <span className="pa-alert-text">{children}</span>}
        {action && <div style={{ marginTop: 6 }}>{action}</div>}
      </div>
      {onClose ? (
        <button type="button" className="pa-btn pa-btn-ghost pa-btn-sm" onClick={onClose} aria-label="Cerrar aviso"><X size={14} /></button>
      ) : <span />}
    </div>
  );
}

// ── Vacío y cargando ────────────────────────────────────

export function EmptyState({ icon: Icon = Info, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="pa-empty">
      <span className="pa-empty-icon"><Icon size={22} aria-hidden /></span>
      <h3 className="pa-empty-title">{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Barras grises mientras carga (en vez de "Cargando…"). */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="pa-skel-stack" aria-busy="true" aria-label="Cargando">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="pa-skel" style={{ width: `${[92, 76, 84, 60, 70][i % 5]}%` }} />
      ))}
    </div>
  );
}

// ── Pestañas ─────────────────────────────────────────────

export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: Array<{ key: K; label: string; count?: number; icon?: LucideIcon }>; value: K; onChange: (key: K) => void }) {
  return (
    <div className="pa-tabs" role="tablist">
      {tabs.map(({ key, label, count, icon: Icon }) => (
        <button key={key} type="button" role="tab" className="pa-tab" aria-selected={value === key} onClick={() => onChange(key)}>
          {Icon && <Icon size={16} aria-hidden />}
          {label}
          {count ? <span className="pa-tab-count">{count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ── Ventana (modal) y confirmación ──────────────────────

/** Ventana encima del panel. Se cierra con Escape o tocando afuera. En el celular sale desde abajo. */
export function Modal({ open, title, onClose, children, footer, size = "md", headerExtra }: { open: boolean; title: string; onClose: () => void; children?: ReactNode; footer?: ReactNode; size?: "md" | "lg"; headerExtra?: ReactNode }) {
  const { theme } = useAdminTheme();
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    boxRef.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="pa" data-pa-theme={theme} style={{ background: "none" }}>
      <div className="pa-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className={`pa-modal${size === "lg" ? " pa-modal-lg" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={boxRef}>
          <div className="pa-modal-head">
            <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
              <h2 className="pa-modal-title">{title}</h2>
              {headerExtra}
            </div>
            <button type="button" className="pa-btn pa-btn-ghost pa-btn-sm" onClick={onClose} aria-label="Cerrar"><X size={16} /></button>
          </div>
          {children}
          {footer && <div className="pa-form-actions">{footer}</div>}
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * Reemplaza la ventanita gris del navegador (window.confirm). Para algo que no se puede deshacer, `typeToConfirm`
 * pide escribir el nombre antes de habilitar el botón (por ejemplo, borrar un cliente).
 */
/** Pedir un texto corto (reemplaza window.prompt). Las sugerencias se eligen con un toque. */
export interface TextInputOptions {
  label: string;
  defaultValue?: string;
  suggestions?: string[];
}

export function ConfirmDialog({ open, title, message, confirmLabel = "Confirmar", danger, typeToConfirm, input, busy, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  typeToConfirm?: string;
  input?: TextInputOptions;
  busy?: boolean;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped(input?.defaultValue ?? "");
  }, [open, input?.defaultValue]);
  const ready = !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.trim().toLowerCase();
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancelar</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={() => onConfirm(typed)} disabled={!ready} loading={busy}>{confirmLabel}</Button>
        </>
      }
    >
      {message && <p className="pa-modal-text">{message}</p>}
      {typeToConfirm && (
        <Field label={`Para confirmar, escribí: ${typeToConfirm}`}>
          {(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
        </Field>
      )}
      {input && (
        <>
          <Field label={input.label}>
            {(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onConfirm(typed)} />}
          </Field>
          {input.suggestions && input.suggestions.length > 0 && (
            <div className="pa-chips">
              {input.suggestions.map((s) => (
                <button key={s} type="button" className="pa-chip" aria-pressed={typed === s} onClick={() => setTyped(s)}>{s}</button>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  typeToConfirm?: string;
}

/**
 * `const [ask, confirmDialog, askText] = useConfirm()`:
 * `if (!(await ask({...}))) return;` en lugar de window.confirm, y `const text = await askText({...})` (null = canceló)
 * en lugar de window.prompt. `confirmDialog` va una vez dentro del panel.
 */
export function useConfirm() {
  const [state, setState] = useState<(ConfirmOptions & { input?: TextInputOptions; resolve: (value: string | null) => void }) | null>(null);
  const ask = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...options, resolve: (v) => resolve(v !== null) })),
    []
  );
  const askText = useCallback(
    (options: ConfirmOptions & { input: TextInputOptions }) => new Promise<string | null>((resolve) => setState({ ...options, resolve })),
    []
  );
  const close = (value: string | null) => {
    state?.resolve(value);
    setState(null);
  };
  const dialog = (
    <ConfirmDialog
      open={state !== null}
      title={state?.title ?? ""}
      message={state?.message}
      confirmLabel={state?.confirmLabel}
      danger={state?.danger}
      typeToConfirm={state?.typeToConfirm}
      input={state?.input}
      onConfirm={(text) => close(text)}
      onCancel={() => close(null)}
    />
  );
  return [ask, dialog, askText] as const;
}

// ── Marca y modo claro/oscuro ───────────────────────────

/** Logo + nombre. Para cambiar de marca: BRAND en lib/brand.ts y, si hay logo nuevo, la marca de acá. */
export function BrandMark({ suffix }: { suffix?: string }) {
  return (
    <span className="pa-brand">
      <span className="pa-brand-mark" aria-hidden>{BRAND.shortName.charAt(0)}</span>
      <span>
        {BRAND.name}
        {suffix && <span className="pa-muted" style={{ fontWeight: 600 }}> · {suffix}</span>}
      </span>
    </span>
  );
}

const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string; icon: LucideIcon }> = [
  { value: "light", label: "Claro", icon: Sun },
  { value: "dark", label: "Oscuro", icon: Moon },
  { value: "auto", label: "Automático", icon: Monitor }
];

export function ThemeToggle() {
  const { choice, setChoice } = useAdminTheme();
  const current = THEME_OPTIONS.find((o) => o.value === choice) ?? THEME_OPTIONS[2];
  const next = THEME_OPTIONS[(THEME_OPTIONS.indexOf(current) + 1) % THEME_OPTIONS.length];
  return (
    <Button variant="ghost" size="sm" icon={current.icon} onClick={() => setChoice(next.value)} title={`Modo: ${current.label}. Tocá para pasar a ${next.label}.`}>
      {current.label}
    </Button>
  );
}
