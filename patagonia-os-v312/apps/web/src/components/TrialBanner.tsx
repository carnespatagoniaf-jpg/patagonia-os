import { useEffect, useState } from "react";
import { useAuth } from "../features/auth/AuthProvider";
import { supabase } from "../lib/supabase";

const WARN_DAYS = 3;

/** Aviso de fin de la prueba gratuita, solo para dueño/admin de la empresa.
 * Nunca bloquea: a veces se hace una excepción, así que vencer solo avisa. */
export function TrialBanner() {
  const { profile } = useAuth();
  const [trialEndsAt, setTrialEndsAt] = useState<string | null>(null);
  const companyId = profile?.company_id;
  const canSee = profile?.role === "owner" || profile?.role === "admin";

  useEffect(() => {
    if (!supabase || !companyId || !canSee) return;
    let cancelled = false;
    void supabase
      .from("companies")
      .select("trial_ends_at, paid_until")
      .eq("id", companyId)
      .maybeSingle()
      .then(({ data }) => {
        const row = data as { trial_ends_at: string | null; paid_until?: string | null } | null;
        // Si ya pagó ("pagado hasta" desde hoy en adelante) no se avisa de la prueba, aunque la fecha de prueba haya quedado cargada (real El Dorado 26/10).
        const paid = Boolean(row?.paid_until && row.paid_until >= new Date().toISOString().slice(0, 10));
        if (!cancelled) setTrialEndsAt(paid ? null : row?.trial_ends_at ?? null);
      });
    return () => { cancelled = true; };
  }, [companyId, canSee]);

  if (!trialEndsAt) return null;
  const daysLeft = Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / 86_400_000);
  if (daysLeft > WARN_DAYS) return null;

  const expired = daysLeft <= 0;
  const text = expired
    ? "Tu prueba gratuita de Patagonia OS terminó. Contactá al equipo de Patagonia OS para seguir usándolo."
    : daysLeft === 1
      ? "Tu prueba gratuita de Patagonia OS termina mañana. Contactá al equipo de Patagonia OS para seguir usándolo."
      : `Te quedan ${daysLeft} días de prueba gratuita de Patagonia OS. Contactá al equipo de Patagonia OS para seguir usándolo.`;

  return <div className={expired ? "message trial-banner trial-expired" : "message warning trial-banner"}>{text}</div>;
}
