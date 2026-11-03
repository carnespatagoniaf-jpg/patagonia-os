// Mercadería entre locales (Sucursales etapa 2, migración 190, plan Empresa). Lógica pura (testeada):
// sugerencia de pedido por mínimo del local, totales, diferencias al recibir y estados.

export type TransferStatus = "pedido" | "preparando" | "en_viaje" | "recibido" | "cancelado";
export type TransferUnit = "kg" | "unit" | "box";

export interface TransferItem {
  id: string;
  productId: string;
  name: string;
  code: string | null;
  unit: TransferUnit;
  /** null = no estaba en el pedido (lo sumó el que manda). */
  requested: number | null;
  sent: number | null;
  received: number | null;
  unitCost: number | null;
}

export interface Transfer {
  id: string;
  number: number;
  fromBranchId: string;
  toBranchId: string;
  status: TransferStatus;
  neededBy: string | null;
  requestNotes: string | null;
  carrier: string | null;
  vehicle: string | null;
  showCost: boolean;
  remitoId: string | null;
  requestedAt: string | null;
  dispatchedAt: string | null;
  receivedAt: string | null;
  receivedByName: string | null;
  receiveNotes: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  items: TransferItem[];
}

export const STATUS_LABELS: Record<TransferStatus, string> = {
  pedido: "Nuevo",
  preparando: "Preparando",
  en_viaje: "En viaje",
  recibido: "Recibido",
  cancelado: "Cancelado"
};

export function unitLabel(unit: TransferUnit | null | undefined): string {
  return unit === "kg" ? "kg" : unit === "box" ? "caj." : "u.";
}

/** "26,4 kg", "3 u." — hasta 3 decimales, con coma. */
export function formatQty(n: number, unit?: TransferUnit | null): string {
  const text = (Math.round(n * 1000) / 1000).toLocaleString("es-AR", { maximumFractionDigits: 3 });
  return unit === undefined ? text : `${text} ${unitLabel(unit)}`;
}

/** Mínimo que vale para ese local: el propio del local o, si no tiene, el general del producto. */
export function effectiveMin(productMin: number, branchMin: number | undefined): number {
  return branchMin !== undefined && branchMin > 0 ? branchMin : Math.max(productMin, 0);
}

/** Lo que falta para llegar al mínimo, redondeado para arriba (al kilo o a la unidad). 0 si no hace falta. */
export function suggestQty(stock: number, min: number): number {
  if (!(min > 0)) return 0;
  const have = Math.max(stock, 0);
  if (have >= min) return 0;
  return Math.ceil(min - have - 1e-9);
}

export interface SuggestionInput {
  productId: string;
  name: string;
  code: string | null;
  unit: TransferUnit;
  stock: number;
  productMin: number;
  active: boolean;
  /** Presentación: usa el stock del principal, no se pide. */
  isPresentation: boolean;
}

export interface SuggestionRow {
  productId: string;
  name: string;
  code: string | null;
  unit: TransferUnit;
  stock: number;
  min: number;
  perDay: number | null;
  suggested: number;
}

/** Productos del local debajo de su mínimo, con lo sugerido para pedir. Los más urgentes (stock/mínimo) primero. */
export function buildSuggestions(
  products: SuggestionInput[],
  branchMins: Map<string, number>,
  perDay: Map<string, number> | null
): SuggestionRow[] {
  const rows: SuggestionRow[] = [];
  for (const p of products) {
    if (!p.active || p.isPresentation) continue;
    const min = effectiveMin(p.productMin, branchMins.get(p.productId));
    const suggested = suggestQty(p.stock, min);
    if (suggested <= 0) continue;
    rows.push({ productId: p.productId, name: p.name, code: p.code, unit: p.unit, stock: p.stock, min, perDay: perDay ? perDay.get(p.productId) ?? 0 : null, suggested });
  }
  return rows.sort((a, b) => Math.max(a.stock, 0) / a.min - Math.max(b.stock, 0) / b.min || a.name.localeCompare(b.name));
}

/** Promedio de venta por día: lo vendido en el período dividido los días. */
export function perDayFromSales(rows: Array<{ productId: string | null; quantity: number }>, days: number): Map<string, number> {
  const out = new Map<string, number>();
  if (days <= 0) return out;
  for (const r of rows) {
    if (!r.productId) continue;
    out.set(r.productId, (out.get(r.productId) ?? 0) + r.quantity / days);
  }
  return out;
}

export interface QtyTotals {
  products: number;
  kg: number;
  units: number;
  cost: number;
}

/** Totales de una lista de cantidades (kilos por un lado, unidades por otro, y el valor a costo). */
export function qtyTotals(lines: Array<{ unit: TransferUnit; qty: number; unitCost?: number | null }>): QtyTotals {
  const t: QtyTotals = { products: 0, kg: 0, units: 0, cost: 0 };
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    t.products += 1;
    if (l.unit === "kg") t.kg += l.qty;
    else t.units += l.qty;
    t.cost += l.qty * (l.unitCost ?? 0);
  }
  t.kg = Math.round(t.kg * 1000) / 1000;
  t.cost = Math.round(t.cost * 100) / 100;
  return t;
}

/** "112 kg y 4 u." */
export function totalsLabel(t: QtyTotals): string {
  const parts: string[] = [];
  if (t.kg > 0) parts.push(formatQty(t.kg, "kg"));
  if (t.units > 0) parts.push(formatQty(t.units, "unit"));
  return parts.join(" y ") || "nada";
}

export interface ReceiveDiff {
  itemId: string;
  name: string;
  unit: TransferUnit;
  sent: number;
  received: number;
  /** received − sent: negativo = faltó, positivo = sobró. */
  diff: number;
  cost: number;
}

/** Diferencias entre lo que se mandó y lo que llegó (solo las que no dan cero). */
export function receiveDiffs(items: TransferItem[], received: Map<string, number>): ReceiveDiff[] {
  const out: ReceiveDiff[] = [];
  for (const i of items) {
    const sent = i.sent ?? 0;
    if (sent <= 0) continue;
    const got = received.get(i.id) ?? i.received;
    if (got === null || got === undefined || !Number.isFinite(got)) continue;
    const diff = Math.round((got - sent) * 1000) / 1000;
    if (diff === 0) continue;
    out.push({ itemId: i.id, name: i.name, unit: i.unit, sent, received: got, diff, cost: Math.round(diff * (i.unitCost ?? 0) * 100) / 100 });
  }
  return out;
}

/** Faltó (en kilos/unidades y a costo) y sobró, sumados. */
export function diffSummary(diffs: ReceiveDiff[]): { missing: QtyTotals; extra: QtyTotals } {
  return {
    missing: qtyTotals(diffs.filter((d) => d.diff < 0).map((d) => ({ unit: d.unit, qty: -d.diff, unitCost: Math.abs(d.cost / d.diff) }))),
    extra: qtyTotals(diffs.filter((d) => d.diff > 0).map((d) => ({ unit: d.unit, qty: d.diff, unitCost: Math.abs(d.cost / d.diff) })))
  };
}

/** Un envío que salió hace más de un día y nadie lo recibió. */
export function isLate(t: Pick<Transfer, "status" | "dispatchedAt">, now: Date): boolean {
  if (t.status !== "en_viaje" || !t.dispatchedAt) return false;
  return now.getTime() - new Date(t.dispatchedAt).getTime() > 24 * 3600_000;
}

/** "hoy 20:15", "ayer 08:10", "hace 3 días" (hora argentina). */
export function whenLabel(iso: string | null, now: Date): string {
  if (!iso) return "";
  const d = new Date(iso);
  const ar = (x: Date) => new Date(x.getTime() - 3 * 3600_000);
  const day = (x: Date) => ar(x).toISOString().slice(0, 10);
  const hhmm = ar(d).toISOString().slice(11, 16);
  const diffDays = Math.round((Date.parse(`${day(now)}T00:00:00Z`) - Date.parse(`${day(d)}T00:00:00Z`)) / 86_400_000);
  if (diffDays <= 0) return `hoy ${hhmm}`;
  if (diffDays === 1) return `ayer ${hhmm}`;
  return `hace ${diffDays} días`;
}

/** Lo que se manda, renglón por renglón, para preparar: lo pedido (con lo que se mande) y lo agregado. */
export interface PrepLine {
  productId: string;
  name: string;
  code: string | null;
  unit: TransferUnit;
  requested: number | null;
  /** Texto del campo (coma o punto). */
  send: string;
}

export function prepLinesFrom(t: Transfer): PrepLine[] {
  return t.items.map((i) => ({
    productId: i.productId,
    name: i.name,
    code: i.code,
    unit: i.unit,
    requested: i.requested,
    send: i.sent !== null && (t.status === "preparando" || i.sent > 0) ? String(i.sent).replace(".", ",") : i.requested !== null ? String(i.requested).replace(".", ",") : ""
  }));
}

/** Diferencias de recepción de varios envíos (para el dueño): una fila por producto con diferencia. */
export function transferDiffRows(transfers: Transfer[]): Array<{ transfer: Transfer; diff: ReceiveDiff }> {
  const out: Array<{ transfer: Transfer; diff: ReceiveDiff }> = [];
  for (const t of transfers) {
    if (t.status !== "recibido") continue;
    for (const diff of receiveDiffs(t.items, new Map())) out.push({ transfer: t, diff });
  }
  return out;
}
