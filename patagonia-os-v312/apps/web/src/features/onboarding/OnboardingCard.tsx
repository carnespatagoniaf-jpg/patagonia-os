import { useEffect, useState } from "react";
import type { Page } from "../auth/permissions";
import { supabase } from "../../lib/supabase";
import { onboardingSteps, type OnboardingStatus } from "./onboarding";

/**
 * "Primeros pasos" en Inicio, solo para dueño/administrador (migración 181). Muestra lo que falta para empezar a
 * usar el sistema y desaparece sola cuando está todo hecho. Si la consulta falla (por ejemplo, antes de la
 * migración), no muestra nada.
 */
export function OnboardingCard({ onNavigate, usesPos }: { onNavigate?: (page: Page) => void; usesPos: boolean }) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    void supabase.rpc("onboarding_status").then(({ data, error }) => {
      if (cancelled || error || !data) return;
      const d = data as { products: number; stock_loaded: boolean; sales: number; account_sales?: number; closed_shifts: number };
      setStatus({ products: Number(d.products), stockLoaded: Boolean(d.stock_loaded), sales: Number(d.sales), accountSales: Number(d.account_sales ?? 0), closedShifts: Number(d.closed_shifts), usesPos });
    });
    return () => {
      cancelled = true;
    };
  }, [usesPos]);

  if (!status) return null;
  const steps = onboardingSteps(status);
  if (steps.every((s) => s.done)) return null;
  const next = steps.find((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-title">
        <h2>Primeros pasos</h2>
        <span className="muted" style={{ fontSize: 13 }}>{doneCount} de {steps.length} hechos</span>
      </div>
      <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 10 }}>
        {steps.map((s) => (
          <li key={s.key} style={{ opacity: s.done ? 0.6 : 1 }}>
            <strong>{s.done ? "✓ " : ""}{s.title}</strong>
            {!s.done && (
              <>
                <div className="muted" style={{ fontSize: 13 }}>{s.help}</div>
                {s === next && onNavigate && (
                  <button style={{ marginTop: 6 }} onClick={() => onNavigate(s.page)}>{s.action}</button>
                )}
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
