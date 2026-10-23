/** Anular una venta de Mostrador (migración 149): motivo obligatorio y, si la
 * empresa cargó uno, PIN de autorización. Lógica pura, sin lib/supabase. */

export const VOID_REASONS = [
  "Me equivoqué al cargar",
  "El cliente se arrepintió",
  "Cobré con el medio de pago equivocado",
  "Otro"
] as const;

export type VoidReason = (typeof VOID_REASONS)[number];

/** Texto que se guarda como motivo, o un error para mostrar. */
export function voidReasonText(choice: string, other: string): { reason: string } | { error: string } {
  if (!choice) return { error: "Elegí por qué se anula." };
  if (choice === "Otro") {
    const detail = other.trim();
    if (detail.length < 3) return { error: "Escribí el motivo." };
    return { reason: `Otro: ${detail}`.slice(0, 200) };
  }
  return { reason: choice };
}

export function isValidAuthPin(pin: string): boolean {
  return /^[0-9]{4,6}$/.test(pin.trim());
}

/** Minutos entre la venta y la anulación, para el detalle del dueño. */
export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000));
}

export function delayLabel(minutes: number): string {
  if (minutes < 1) return "al toque";
  if (minutes < 60) return `${minutes} min después`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min después` : `${h} h después`;
}
