// Precios por local desde Excel (pantalla a pedido 'precios_excel', migración 211; por ahora solo Della Finca).
// Una planilla con Código (o Producto) y una columna por local o por zona, con el precio de cada producto ahí.
// Lógica pura (sin supabase) para poder probarla: lee la tabla y dice qué precio va a qué zona.
//
// Reglas:
// - Columna con el nombre de un local: va a la zona de ESE local. Si no tiene zona, se le crea una (+0 %) con su nombre.
//   Si su zona es compartida con otros locales no se toca (cambiaría el precio de los otros): hay que usar el nombre de la zona.
// - Columna con el nombre de una zona: va a esa zona.
// - Celda vacía = ese precio no se toca. Un producto que no está en la planilla tampoco.
// - El producto se busca por código; sin código, por el nombre exacto.

import { normalizeHeader, parseNumberCell, type Cell, type Table } from "../import/import-parse";

export interface ImportProduct {
  id: string;
  code: string;
  name: string;
  /** Precio actual en cada zona: zona → {precio, a mano}. */
  listPrices?: Record<string, { price: number; manual: boolean }>;
}

export interface ImportBranch {
  id: string;
  name: string;
  /** Zona del local, o null = precio general. */
  zoneId: string | null;
}

export interface ImportZone {
  id: string;
  name: string;
}

/** Adónde va una columna: una zona que ya existe, o una zona nueva para un local que no tiene. */
export type ColumnTarget =
  | { kind: "zone"; zoneId: string; label: string; branchName: string | null }
  | { kind: "new-zone"; branchId: string; label: string };

export interface ImportColumn {
  index: number;
  header: string;
  target: ColumnTarget;
  /** producto → precio de la planilla (solo celdas con número). */
  prices: Map<string, number>;
  /** Cuántos de esos precios son distintos de lo que hay hoy. */
  changed: number;
}

export interface ZonePricesImport {
  columns: ImportColumn[];
  /** Encabezados que no son un local ni una zona (se ignoran). */
  ignored: string[];
  /** Locales cuya zona es compartida: no se pueden cargar por el nombre del local. */
  shared: { header: string; zoneName: string }[];
  /** Filas con un código o nombre que no existe. */
  unknown: { row: number; text: string }[];
  /** Celdas que no son un precio. */
  errors: { row: number; header: string; text: string }[];
  /** Filas de productos leídas (con producto encontrado). */
  rows: number;
}

const CODE_HEADERS = new Set(["codigo", "cod", "codigoproducto", "codproducto", "plu", "codigoplu", "sku", "id", "articulo", "codarticulo", "codigoarticulo"]);
const NAME_HEADERS = new Set(["producto", "nombre", "descripcion", "nombreproducto", "detalle"]);
/** Columnas de referencia que se ignoran sin avisar (vienen en la planilla que se baja). */
const QUIET_HEADERS = new Set(["general", "preciogeneral", "costo", "unidad", "categoria", "rubro", "seccion"]);

function text(cell: Cell): string {
  if (cell === null || cell === undefined || cell instanceof Date) return "";
  return String(cell).trim();
}

function codeText(cell: Cell): string {
  if (typeof cell === "number") return String(cell);
  return text(cell).replace(/\.0+$/, "");
}

/** Saca "precio", "lista", "$" del encabezado: "Precio Trejo $" → "trejo". */
function headerKey(cell: Cell): string {
  const key = normalizeHeader(cell);
  const stripped = key.replace(/^(precio|lista|listade|preciode)+/, "").replace(/(precio|lista)$/, "");
  return stripped || key;
}

/** Primera fila que tenga una columna de código o de producto (puede haber un título arriba). */
function findHeaderRow(table: Table): number {
  for (let i = 0; i < Math.min(table.length, 10); i++) {
    if ((table[i] ?? []).some((c) => CODE_HEADERS.has(normalizeHeader(c)) || NAME_HEADERS.has(normalizeHeader(c)))) return i;
  }
  return -1;
}

export function readZonePrices(table: Table, products: ImportProduct[], branches: ImportBranch[], zones: ImportZone[]): ZonePricesImport {
  const headerRow = findHeaderRow(table);
  if (headerRow < 0) throw new Error('No encontré la columna "Código" (o "Producto") en las primeras filas. Bajá la planilla de ejemplo y usá esos encabezados.');
  const header = table[headerRow] ?? [];
  const codeCol = header.findIndex((c) => CODE_HEADERS.has(normalizeHeader(c)));
  const nameCol = header.findIndex((c) => NAME_HEADERS.has(normalizeHeader(c)));

  const byCode = new Map<string, ImportProduct>();
  const byName = new Map<string, ImportProduct | null>();
  for (const p of products) {
    byCode.set(normalizeHeader(p.code), p);
    const n = normalizeHeader(p.name);
    byName.set(n, byName.has(n) ? null : p); // nombre repetido: no se puede usar
  }
  const branchByKey = new Map(branches.map((b) => [normalizeHeader(b.name), b]));
  const zoneByKey = new Map(zones.map((z) => [normalizeHeader(z.name), z]));
  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? "";
  const branchesInZone = (id: string) => branches.filter((b) => b.zoneId === id).length;

  const columns: ImportColumn[] = [];
  const ignored: string[] = [];
  const shared: ZonePricesImport["shared"] = [];
  const used = new Set<string>();
  header.forEach((cell, index) => {
    if (index === codeCol || index === nameCol) return;
    const label = text(cell);
    if (!label) return;
    const full = normalizeHeader(cell);
    const key = headerKey(cell);
    const branch = branchByKey.get(full) ?? branchByKey.get(key);
    const zone = zoneByKey.get(full) ?? zoneByKey.get(key);
    let target: ColumnTarget | null = null;
    if (branch) {
      if (!branch.zoneId) target = { kind: "new-zone", branchId: branch.id, label: branch.name };
      else if (branchesInZone(branch.zoneId) === 1) target = { kind: "zone", zoneId: branch.zoneId, label: branch.name, branchName: branch.name };
      else if (zone) target = { kind: "zone", zoneId: zone.id, label: zone.name, branchName: null };
      else {
        shared.push({ header: label, zoneName: zoneName(branch.zoneId) });
        return;
      }
    } else if (zone) {
      target = { kind: "zone", zoneId: zone.id, label: zone.name, branchName: null };
    }
    if (!target) {
      if (!QUIET_HEADERS.has(full) && !QUIET_HEADERS.has(key)) ignored.push(label);
      return;
    }
    const id = target.kind === "zone" ? target.zoneId : `new:${target.branchId}`;
    if (used.has(id)) {
      ignored.push(`${label} (repetida)`);
      return;
    }
    used.add(id);
    columns.push({ index, header: label, target, prices: new Map(), changed: 0 });
  });
  if (columns.length === 0) {
    throw new Error(
      `Ninguna columna tiene el nombre de un local. Los locales son: ${branches.map((b) => b.name).join(", ")}.` +
        (ignored.length ? ` La planilla trae: ${ignored.join(", ")}.` : "")
    );
  }

  const unknown: ZonePricesImport["unknown"] = [];
  const errors: ZonePricesImport["errors"] = [];
  let rows = 0;
  for (let r = headerRow + 1; r < table.length; r++) {
    const row = table[r] ?? [];
    const code = codeCol >= 0 ? codeText(row[codeCol]) : "";
    const name = nameCol >= 0 ? text(row[nameCol]) : "";
    if (!code && !name) continue;
    const product = (code ? byCode.get(normalizeHeader(code)) : undefined) ?? (name ? byName.get(normalizeHeader(name)) ?? undefined : undefined);
    if (!product) {
      unknown.push({ row: r + 1, text: [code, name].filter(Boolean).join(" · ") });
      continue;
    }
    rows++;
    for (const col of columns) {
      const cell = row[col.index];
      const { value, invalid } = parseNumberCell(cell, true);
      if (invalid || (value !== null && !(value > 0))) {
        errors.push({ row: r + 1, header: col.header, text: text(cell) || String(cell) });
        continue;
      }
      if (value === null) continue;
      const price = Math.round(value * 100) / 100;
      col.prices.set(product.id, price);
    }
  }

  for (const col of columns) {
    for (const [productId, price] of col.prices) {
      const cur = col.target.kind === "zone" ? products.find((p) => p.id === productId)?.listPrices?.[col.target.zoneId] : undefined;
      if (!cur || !cur.manual || cur.price !== price) col.changed++;
    }
  }

  return { columns, ignored, shared, unknown, errors, rows };
}

/** Planilla para bajar: Código, Producto, General y una columna por local con el precio que cobra hoy. */
export function zonePricesSheet(
  products: (ImportProduct & { priceRetail: number })[],
  branches: ImportBranch[]
): (string | number)[][] {
  const header = ["Código", "Producto", "General", ...branches.map((b) => b.name)];
  const rows = products.map((p) => [
    p.code,
    p.name,
    p.priceRetail,
    ...branches.map((b) => (b.zoneId ? p.listPrices?.[b.zoneId]?.price ?? p.priceRetail : p.priceRetail))
  ]);
  return [header, ...rows];
}

/** De a cuántos se mandan a set_product_list_prices (acepta hasta 3000 por llamada). */
export const SAVE_CHUNK = 1000;

export function chunk<T>(items: T[], size = SAVE_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
