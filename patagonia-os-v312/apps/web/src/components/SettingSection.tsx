import type { ReactNode } from "react";

/**
 * Fila de configuración: en una línea el título y su estado ("Activado", "Sin configurar"…);
 * lo que hay que tocar para configurarlo aparece recién al abrirla. Así la pantalla muestra
 * de un vistazo cómo está todo, sin un muro de texto.
 */
export function SettingSection({
  title,
  status,
  tone = "neutral",
  defaultOpen = false,
  actionLabel = "Configurar",
  children
}: {
  title: string;
  status?: string;
  tone?: "ok" | "warn" | "neutral";
  defaultOpen?: boolean;
  actionLabel?: string;
  children: ReactNode;
}) {
  return (
    <details className="setting-section" open={defaultOpen}>
      <summary>
        <span className="setting-title">{title}</span>
        {status && <span className={`setting-status ${tone === "neutral" ? "" : tone}`}>{status}</span>}
        <span className="setting-action">{actionLabel}</span>
      </summary>
      <div className="setting-body">{children}</div>
    </details>
  );
}
