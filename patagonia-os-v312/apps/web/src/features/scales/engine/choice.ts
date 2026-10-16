import type { RememberedScale } from "./memory";

/**
 * "¿Qué balanza tenés?": el cliente elige su balanza y "Mi balanza" conecta directo con la configuración de
 * ESE modelo, en segundos. Antes se adivinaba la marca probando todas, y una Report LT real (Carnes Patagonia,
 * 16/10/2026) tardaba o no aparecía. "No sé" mantiene la búsqueda automática de siempre.
 */

export type ScaleChoice = "kretz-aura" | "kretz-report" | "systel" | "auto";

export interface ScaleChoiceOption {
  id: ScaleChoice;
  label: string;
  hint: string;
}

export const SCALE_CHOICES: ScaleChoiceOption[] = [
  { id: "kretz-aura", label: "Kretz Aura", hint: "Kretz chica, la Aura o Aura Eco" },
  { id: "kretz-report", label: "Kretz Report", hint: "Kretz Report LT o NX, con impresora de tickets" },
  { id: "systel", label: "Systel", hint: "Systel Cuora (Max, Neo)" },
  { id: "auto", label: "No sé cuál es", hint: "Patagonia la busca sola (tarda un poco más)" }
];

const KEY = "patagonia-my-scale-choice";

export function choiceLabel(choice: ScaleChoice): string {
  return SCALE_CHOICES.find((c) => c.id === choice)?.label ?? "";
}

/** La balanza que ya conectó esta PC, traducida a lo que se elige (para que los clientes que ya andan no tengan que elegir). */
export function choiceFromRemembered(r: RememberedScale | null): ScaleChoice | null {
  if (!r) return null;
  if (r.model === "kretz-aura") return "kretz-aura";
  if (r.model === "kretz-report-lt") return "kretz-report";
  if (r.family === "systel") return "systel";
  return null;
}

export function loadScaleChoice(remembered: RememberedScale | null): ScaleChoice | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v && SCALE_CHOICES.some((c) => c.id === v)) return v as ScaleChoice;
  } catch {
    // sin localStorage
  }
  return choiceFromRemembered(remembered);
}

export function saveScaleChoice(choice: ScaleChoice | null): void {
  try {
    if (choice) localStorage.setItem(KEY, choice);
    else localStorage.removeItem(KEY);
  } catch {
    // no crítico: la próxima vez se pregunta de nuevo
  }
}

/** Qué marca y qué modelo de Kretz probar según lo elegido. "auto" = todas, como antes. */
export function searchPlan(choice: ScaleChoice): { families: ("kretz" | "systel")[]; kretzOnly: "aura" | "report-lt" | null } {
  if (choice === "kretz-aura") return { families: ["kretz"], kretzOnly: "aura" };
  if (choice === "kretz-report") return { families: ["kretz"], kretzOnly: "report-lt" };
  if (choice === "systel") return { families: ["systel"], kretzOnly: null };
  return { families: ["kretz", "systel"], kretzOnly: null };
}
