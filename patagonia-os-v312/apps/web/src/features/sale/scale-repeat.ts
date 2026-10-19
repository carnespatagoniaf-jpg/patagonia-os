import { formatMoney } from "../shifts/format";
import { hourAr } from "./scale-void-warning";

/**
 * Papel de la balanza escaneado dos veces (Kretz: etiquetas y tickets de TOTAL; las Systel "artículos + TOTAL" ya lo
 * controla el servidor, migración 119). Ver docs/BALANZAS_DIAGNOSTICO_2026-10-19.md §5.
 *
 * Nunca se bloquea: dos clientes pueden llevar exactamente lo mismo (mismo producto y mismos gramos, o el mismo
 * total), así que se PREGUNTA. Antes no se avisaba nada: la misma etiqueta sumaba los kilos en silencio.
 */

export interface ChargedHit {
  /** null = se sabe que se cobró pero no a qué hora. */
  createdAt: string | null;
  amount: number;
  by: string | null;
}

export function chargedTicketQuestion(hit: ChargedHit): string {
  return (
    `Este ticket de la balanza parece ya cobrado: ${formatMoney(hit.amount)}${hit.createdAt ? ` a las ${hourAr(hit.createdAt)}` : ""}${hit.by ? ` (${hit.by})` : ""}.\n\n` +
    "¿Es OTRO ticket igual (otro cliente que llevó exactamente lo mismo)?\n\nAceptar = sí, es otro: cobrarlo.\nCancelar = es el mismo papel: no se agrega."
  );
}

export const SAME_SALE_LABEL_QUESTION =
  "Ya escaneaste esta misma etiqueta en esta venta.\n\n¿Es OTRA etiqueta igual (mismo producto y mismo peso)?\n\nAceptar = sí, agregarla.\nCancelar = es la misma: no se agrega.";

/** Clave con la que se guarda el primer renglón de un TOTAL detallado (ticket-detail.ts): sirve para buscarlo cobrado. */
export function detailedTotalKey(totalKey: string): string {
  return `${totalKey}#1`;
}
