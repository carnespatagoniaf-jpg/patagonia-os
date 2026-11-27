import type { BranchScale } from "./registry/scale-identity";
import type { InstallRecord } from "./install-status";

/**
 * Textos de "Mis balanzas" que ve el cliente (lógica pura, probada). El dueño pide que conectar y enviar sea SENCILLO:
 * cada tarjeta dice qué balanza es y cuándo se le mandó por última vez, y el resultado de un envío dice cuántos
 * productos quedaron comprobados y qué hacer con los demás. Nada de puertos, velocidades ni protocolos acá.
 */

/** "Kretz", "Systel": la marca, para la tarjeta. */
export function brandLabel(s: Pick<BranchScale, "family">): string {
  return s.family === "kretz" ? "Kretz" : "Systel";
}

/** "Kretz Report" / "Systel Cuora Max" sin repetir la marca si el modelo ya la dice. */
export function brandAndModel(s: Pick<BranchScale, "family" | "model">): string {
  const brand = brandLabel(s);
  const model = (s.model ?? "").trim();
  if (!model) return brand;
  return model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${brand} ${model}`;
}

/** "Último envío: hoy 10:15 (40 productos)" o "Todavía no se le enviaron productos". */
export function lastSendText(install: InstallRecord | null | undefined, now = new Date()): string {
  const at = install?.sentAt ? new Date(install.sentAt) : null;
  if (!at || Number.isNaN(at.getTime())) return "Todavía no se le enviaron productos";
  const hh = at.toLocaleTimeString("es-AR", { hour: "2-digit", hourCycle: "h23", minute: "2-digit" });
  const when = at.toDateString() === now.toDateString() ? `hoy ${hh}` : `el ${at.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })} ${hh}`;
  const n = typeof install?.verifiedCount === "number" ? install.verifiedCount : typeof install?.sentCount === "number" ? install.sentCount : null;
  return `Último envío: ${when}${n !== null ? ` (${n} ${n === 1 ? "producto" : "productos"})` : ""}`;
}

export interface SendSummaryInput {
  /** Ya estaban iguales o vinculados antes de enviar (PreparedSync.ready). */
  ready: number;
  /** Escritos y releídos iguales en este envío (SyncOutcome.verified). */
  verified: number;
  /** No quedaron bien (SyncOutcome.failures). */
  failed: number;
  /** De Patagonia que no van a la balanza (PreparedSync.skipped). */
  skipped: number;
  /** De la balanza que hay que decir qué producto son (sin contar los números ocupados). */
  toReview: number;
  /** Números de la balanza con otro producto que no se reemplazaron. */
  occupied: number;
}

/** El resultado final de un envío: "X de Y productos quedaron y se comprobaron en la balanza" y qué hacer con el resto. */
export function sendSummary(i: SendSummaryInput): { headline: string; next: string[]; allOk: boolean } {
  const ok = Math.max(0, i.ready + i.verified);
  const total = ok + Math.max(0, i.failed) + Math.max(0, i.skipped);
  const p = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const headline = total === 0 ? "No había productos para enviar a la balanza." : `${ok} de ${p(total, "producto quedó y se comprobó", "productos quedaron y se comprobaron")} en la balanza.`;
  const next: string[] = [];
  if (i.failed > 0) next.push(`${p(i.failed, "no quedó bien", "no quedaron bien")}: mirá el motivo en la lista de abajo, corregilo en Stock y tocá "Enviar de nuevo".`);
  if (i.skipped > 0) next.push(`${p(i.skipped, "producto no va", "productos no van")} a la balanza (por ejemplo, sin precio o con un código muy largo): el motivo está en la lista. Si lo querés en la balanza, corregilo en Stock y enviá de nuevo.`);
  if (i.occupied > 0) next.push(`${p(i.occupied, "número de la balanza tiene", "números de la balanza tienen")} otro producto y no se tocaron. Para cambiarlos, tocá "Enviar de nuevo" y marcá "Reemplazarlos".`);
  if (i.toReview > 0) next.push(`${p(i.toReview, "producto de la balanza", "productos de la balanza")} para revisar: elegí abajo qué producto de Patagonia es cada uno.`);
  const allOk = total > 0 && i.failed === 0 && i.skipped === 0 && i.occupied === 0 && i.toReview === 0;
  if (allOk) next.push("Ya podés vender: imprimí una etiqueta en la balanza y escaneala en Mostrador para probar.");
  return { headline, next, allOk };
}
