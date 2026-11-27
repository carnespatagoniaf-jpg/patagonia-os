// Freezer (migración 214, pedido del dueño 26/11/2026). Lógica pura, sin Supabase ni navegador (ver freezer-logic.test.ts).
//
// Cada paquete es una bolsa con la etiqueta de la balanza del local (producto + kilos). Guardar no mueve stock: el
// freezer dice DÓNDE está la mercadería. En Mostrador, una etiqueta que está en el freezer de ese local entra como su
// propia línea con los kilos que se guardaron y viaja como pos_sale_items.scale_ticket = "FRZ-" + código; la base saca
// del freezer la bolsa más vieja con ese código.

export type FreezerStatus = "guardado" | "vendido" | "sacado";

export interface FreezerPackage {
  id: string;
  productId: string;
  quantity: number;
  /** Código de la etiqueta de la balanza. null si se cargó a mano (esa bolsa se saca a mano). */
  code: string | null;
  status: FreezerStatus;
  storedAt: string;
  outAt: string | null;
  outReason: string | null;
  posSaleId: string | null;
}

/** Lo que Mostrador necesita de cada bolsa guardada (se guarda también sin conexión). */
export interface FreezerStored {
  code: string;
  productId: string;
  quantity: number;
}

export const FREEZER_TICKET_PREFIX = "FRZ-";
export const freezerTicket = (code: string) => `${FREEZER_TICKET_PREFIX}${code}`;

/** Una bolsa que lleva más de esto en el freezer se marca para venderla primero. */
export const FREEZER_OLD_DAYS = 90;

/** Motivos para sacar a mano (lo vendido sale solo). */
export const TAKE_OUT_REASONS = ["Se usó en el local", "Se mandó a otro local", "Se tiró", "Se cargó por error"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Días enteros que lleva guardada (0 = hoy). */
export function daysStored(storedAt: string, now: Date = new Date()): number {
  const t = Date.parse(storedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

export function daysText(days: number): string {
  if (days === 0) return "hoy";
  if (days === 1) return "ayer";
  return `hace ${days} días`;
}

export interface FreezerRow {
  productId: string;
  name: string;
  unit: "kg" | "unit" | "box";
  packages: FreezerPackage[];
  count: number;
  quantity: number;
  oldestDays: number;
}

export interface FreezerSummary {
  rows: FreezerRow[];
  packages: number;
  kg: number;
  /** Bolsas con más de FREEZER_OLD_DAYS días. */
  old: number;
}

interface ProductLike {
  id: string;
  name: string;
  unit: "kg" | "unit" | "box";
}

/** Lo guardado, por producto, con el que tiene la bolsa más vieja primero (para venderla antes). */
export function summarizeFreezer(packages: FreezerPackage[], products: ProductLike[], now: Date = new Date()): FreezerSummary {
  const byId = new Map(products.map((p) => [p.id, p]));
  const map = new Map<string, FreezerRow>();
  let kg = 0;
  let old = 0;
  const stored = packages.filter((p) => p.status === "guardado").sort((a, b) => a.storedAt.localeCompare(b.storedAt));
  for (const pkg of stored) {
    const product = byId.get(pkg.productId);
    const row = map.get(pkg.productId) ?? {
      productId: pkg.productId,
      name: product?.name ?? "Producto borrado",
      unit: product?.unit ?? "kg",
      packages: [],
      count: 0,
      quantity: 0,
      oldestDays: daysStored(pkg.storedAt, now)
    };
    row.packages.push(pkg);
    row.count += 1;
    row.quantity = Math.round((row.quantity + pkg.quantity) * 1000) / 1000;
    map.set(pkg.productId, row);
    if (row.unit === "kg") kg += pkg.quantity;
    if (daysStored(pkg.storedAt, now) >= FREEZER_OLD_DAYS) old += 1;
  }
  const rows = [...map.values()].sort((a, b) => b.oldestDays - a.oldestDays || a.name.localeCompare(b.name, "es"));
  return { rows, packages: stored.length, kg: Math.round(kg * 1000) / 1000, old };
}

/** Lo que Mostrador guarda para reconocer las etiquetas del freezer. */
export function storedForSale(packages: FreezerPackage[]): FreezerStored[] {
  return packages
    .filter((p): p is FreezerPackage & { code: string } => p.status === "guardado" && !!p.code)
    .sort((a, b) => a.storedAt.localeCompare(b.storedAt))
    .map((p) => ({ code: p.code, productId: p.productId, quantity: p.quantity }));
}

/**
 * ¿La etiqueta escaneada en Mostrador es una bolsa del freezer? Devuelve la bolsa guardada más vieja con ese código
 * que todavía no está en la venta (dos bolsas con el mismo peso tienen el mismo código: cada escaneo es una).
 * `inCart` = cuántas líneas del freezer con ese código ya hay en la venta. null si no es del freezer o ya están todas.
 */
export function matchFreezerScan(raw: string, stored: FreezerStored[], inCart: number): FreezerStored | null {
  const code = raw.trim();
  if (!code) return null;
  const same = stored.filter((s) => s.code === code);
  return same[inCart] ?? null;
}

/** ¿Cuántas bolsas guardadas tienen ya esta etiqueta? (para preguntar antes de guardar otra igual). */
export function sameCodeStored(code: string, packages: FreezerPackage[]): number {
  if (!code) return 0;
  return packages.filter((p) => p.status === "guardado" && p.code === code).length;
}
