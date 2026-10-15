import { formatMoney } from "../shifts/format";

/**
 * Textos de los avisos "anulado y cobrado" del control de balanza (migración 125). Lógica pura, probada.
 *
 * Real, Haedo: 6/10 Suprema 0,826 kg $11.481 cobrada 19:45 y anulada 20:24; 13/10 Oferta mila 1,304 kg
 * $9.780 anulada 14:14 y cobrada 14:24. Un papel anulado Y cobrado se resta en el control aunque se cobró,
 * y tapa un faltante real del mismo importe.
 */

export interface TicketHit {
  createdAt: string;
  amount: number;
  by: string | null;
}

/** Hora argentina (HH:MM), sin depender del huso de la PC. */
export function hourAr(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Argentina/Buenos_Aires" });
}

const who = (by: string | null) => (by && by.trim() ? ` por ${by.trim()}` : "");

/** Mostrador, al escanear un papel que ya está anulado. */
export function voidedTicketQuestion(hit: TicketHit): string {
  return `Este ticket fue anulado a las ${hourAr(hit.createdAt)}${who(hit.by)} (${formatMoney(hit.amount)}). ¿Cobrarlo igual?`;
}

/** Mostrador, si se cobra igual: deshacer la anulación para que el control no lo reste. */
export function undoVoidQuestion(hit: TicketHit): string {
  return `¿Deshacer la anulación de las ${hourAr(hit.createdAt)}? Si lo cobrás y queda anulado, el control de la balanza lo resta igual y puede tapar un faltante de ${formatMoney(hit.amount)}.`;
}

/** "Anular ticket de balanza", cuando ese papel ya se cobró en los turnos del control. */
export function chargedTicketWarning(hit: TicketHit): string {
  return `Este ticket ya se cobró a las ${hourAr(hit.createdAt)}${who(hit.by)} (${formatMoney(hit.amount)}). Si lo anulás, el control de la balanza lo resta aunque se cobró y puede tapar un faltante. Anulalo solo si esa venta se anuló o se devolvió la mercadería.`;
}
