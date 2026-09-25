// Lectura y validación de archivos para importar productos, proveedores y clientes.
// Puro (sin React ni Supabase) a propósito: se prueba solo (import-parse.test.ts).
// La validación de acá es para mostrar la vista previa; la de verdad la vuelve a
// hacer el servidor (funciones import_* de la migración 096).

export type ImportKind = "products" | "suppliers" | "customers";
export type Cell = string | number | boolean | Date | null | undefined;
export type Table = Cell[][];

export type RowStatus = "new" | "update" | "skip" | "error";

export interface ImportRow<P> {
  /** Número de fila en el archivo (la primera fila de datos es la 2). */
  row: number;
  status: RowStatus;
  errors: string[];
  warnings: string[];
  payload?: P;
  /** Texto corto para mostrar en la vista previa. */
  label: string;
}

/* ------------------------------ lectura de texto ------------------------------ */

/** UTF-8 si es válido; si no, Windows-1252 (así guarda Excel en español los CSV). Saca el BOM. */
export function decodeFileBytes(buffer: ArrayBuffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder("windows-1252").decode(buffer);
  }
  return text.replace(/^﻿/, "");
}

function detectDelimiter(firstLine: string): string {
  const counts = { ";": 0, ",": 0, "\t": 0 } as Record<string, number>;
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ";";
}

/** CSV/TSV con comillas; detecta el separador (; , o tabulación, este último al pegar desde Excel). */
export function parseDelimited(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ------------------------------ encabezados ------------------------------ */

export function normalizeHeader(header: Cell): string {
  return String(header ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

type FieldSynonyms = Record<string, string[]>;

const PRODUCT_FIELDS: FieldSynonyms = {
  code: ["codigo", "cod", "plu", "codigodeproducto", "codigoproducto", "sku", "codigoplu"],
  name: ["nombre", "producto", "descripcion", "detalle", "articulo", "denominacion"],
  unit: ["unidad", "un", "unidaddemedida", "um", "medida"],
  cost: ["costo", "costounitario", "preciocosto", "preciodecosto", "preciocompra", "preciodecompra"],
  price: ["precio", "precioventa", "preciodeventa", "pvp", "venta", "preciopublico", "precioalpublico"],
  stock: ["stock", "existencia", "stockactual", "stockinicial", "cantidad"],
  minStock: ["stockminimo", "minimo", "stockmin", "min"],
  category: ["categoria", "rubro", "familia", "grupo", "seccion"]
};

const SUPPLIER_FIELDS: FieldSynonyms = {
  name: ["nombre", "proveedor", "razonsocial", "empresa"],
  category: ["rubro", "categoria", "tipo"],
  phone: ["telefono", "tel", "celular", "whatsapp", "cel"],
  notes: ["notas", "nota", "observaciones", "obs", "comentarios"]
};

const CUSTOMER_FIELDS: FieldSynonyms = {
  name: ["nombre", "cliente", "razonsocial"],
  phone: ["telefono", "tel", "celular", "whatsapp", "cel"],
  locality: ["localidad", "ciudad", "zona"],
  province: ["provincia"],
  notes: ["notas", "nota", "observaciones", "obs", "comentarios"]
};

export const REQUIRED_FIELDS: Record<ImportKind, string[]> = {
  products: ["code", "name"],
  suppliers: ["name"],
  customers: ["name"]
};

export const FIELD_LABELS: Record<string, string> = {
  code: "Código",
  name: "Nombre",
  unit: "Unidad",
  cost: "Costo",
  price: "Precio de venta",
  stock: "Stock",
  minStock: "Stock mínimo",
  category: "Categoría / Rubro",
  phone: "Teléfono",
  notes: "Notas",
  locality: "Localidad",
  province: "Provincia"
};

const FIELDS_BY_KIND: Record<ImportKind, FieldSynonyms> = {
  products: PRODUCT_FIELDS,
  suppliers: SUPPLIER_FIELDS,
  customers: CUSTOMER_FIELDS
};

export interface ColumnMapping {
  /** campo -> índice de columna */
  columns: Record<string, number>;
  /** encabezados del archivo que no se reconocieron (se ignoran) */
  ignored: string[];
  missingRequired: string[];
}

export function mapColumns(kind: ImportKind, headerRow: Cell[]): ColumnMapping {
  const synonyms = FIELDS_BY_KIND[kind];
  const columns: Record<string, number> = {};
  const ignored: string[] = [];

  headerRow.forEach((cell, index) => {
    const normalized = normalizeHeader(cell);
    if (!normalized) return;
    const field = Object.keys(synonyms).find((f) => synonyms[f].includes(normalized));
    if (field && columns[field] === undefined) columns[field] = index;
    else ignored.push(String(cell).trim());
  });

  return { columns, ignored, missingRequired: REQUIRED_FIELDS[kind].filter((f) => columns[f] === undefined) };
}

/* ------------------------------ valores ------------------------------ */

function cellText(cell: Cell): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return "";
  if (typeof cell === "number") return Number.isInteger(cell) ? String(cell) : String(cell);
  return String(cell).trim();
}

/** Número en formato argentino o "de máquina". `dotIsThousands`: para precios y costos, "15.000" es quince mil. */
export function parseNumberCell(cell: Cell, dotIsThousands: boolean): { value: number | null; invalid: boolean } {
  if (cell === null || cell === undefined) return { value: null, invalid: false };
  if (typeof cell === "number") return Number.isFinite(cell) ? { value: cell, invalid: false } : { value: null, invalid: true };
  if (cell instanceof Date || typeof cell === "boolean") return { value: null, invalid: true };

  let text = String(cell).replace(/ /g, " ").trim();
  if (text === "") return { value: null, invalid: false };
  text = text.replace(/\$/g, "").replace(/\s+/g, "").replace(/kgs?$/i, "");
  if (text === "") return { value: null, invalid: true };
  if (!/^-?[0-9.,]+$/.test(text)) return { value: null, invalid: true };

  const hasDot = text.includes(".");
  const hasComma = text.includes(",");
  let normalized = text;
  if (hasDot && hasComma) {
    normalized = text.lastIndexOf(",") > text.lastIndexOf(".") ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (hasComma) {
    normalized = text.replace(/\./g, "").replace(",", ".");
  } else if (hasDot) {
    const thousands = /^-?\d{1,3}(\.\d{3})+$/.test(text) && !/^-?0\./.test(text);
    normalized = dotIsThousands && thousands ? text.replace(/\./g, "") : text;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? { value, invalid: false } : { value: null, invalid: true };
}

const UNIT_ALIASES: Record<string, "kg" | "unit" | "box"> = {
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogramo: "kg", kilogramos: "kg",
  u: "unit", un: "unit", unid: "unit", unidad: "unit", unidades: "unit", unit: "unit", unitario: "unit",
  caja: "box", cajas: "box", cj: "box", box: "box"
};

export function parseUnit(cell: Cell): "kg" | "unit" | "box" | null {
  const key = normalizeHeader(cell);
  return UNIT_ALIASES[key] ?? null;
}

/** El código puede venir como número de Excel (105) o texto ("105", "12.0"). */
function parseCode(cell: Cell): string {
  if (typeof cell === "number") return Number.isInteger(cell) ? String(cell) : String(cell);
  return cellText(cell).replace(/\.0+$/, "");
}

function isEmptyRow(row: Cell[]): boolean {
  return row.every((c) => cellText(c) === "");
}

/* ------------------------------ productos ------------------------------ */

export interface ProductPayload {
  row: number;
  code: string;
  name: string;
  unit: "kg" | "unit" | "box";
  cost: number;
  price_retail: number;
  min_stock: number;
  category: string;
  stock: number | null;
}

export function buildProductRows(
  table: Table,
  mapping: ColumnMapping,
  existingCodes: Set<string>,
  updateExisting: boolean
): ImportRow<ProductPayload>[] {
  const c = mapping.columns;
  const rows: ImportRow<ProductPayload>[] = [];
  const seen = new Set<string>();

  table.slice(1).forEach((raw, i) => {
    if (isEmptyRow(raw)) return;
    const row = i + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const get = (field: string): Cell => (c[field] === undefined ? undefined : raw[c[field]]);

    const code = parseCode(get("code"));
    const name = cellText(get("name"));
    if (!code) errors.push("Falta el código");
    if (!name) errors.push("Falta el nombre");

    let unit: "kg" | "unit" | "box" = "kg";
    if (c.unit !== undefined && cellText(get("unit")) !== "") {
      const parsed = parseUnit(get("unit"));
      if (parsed) unit = parsed;
      else errors.push(`Unidad no reconocida: "${cellText(get("unit"))}" (usá kg, unidad o caja)`);
    } else {
      warnings.push("Sin unidad: se usa kg");
    }

    const cost = parseNumberCell(get("cost"), true);
    const price = parseNumberCell(get("price"), true);
    const stock = parseNumberCell(get("stock"), false);
    const min = parseNumberCell(get("minStock"), false);
    if (cost.invalid) errors.push("El costo no es un número");
    if (price.invalid) errors.push("El precio no es un número");
    if (stock.invalid) errors.push("El stock no es un número");
    if (min.invalid) errors.push("El stock mínimo no es un número");
    if ((cost.value ?? 0) < 0 || (price.value ?? 0) < 0 || (stock.value ?? 0) < 0 || (min.value ?? 0) < 0) errors.push("No puede haber números negativos");
    if (!price.invalid && (price.value ?? 0) === 0) warnings.push("Sin precio de venta");
    if ((cost.value ?? 0) > 0 && (price.value ?? 0) > 0 && (price.value as number) < (cost.value as number)) warnings.push("El precio es menor al costo");

    const key = code.toLowerCase();
    if (code) {
      if (seen.has(key)) errors.push(`El código ${code} está repetido en el archivo`);
      seen.add(key);
    }

    let status: RowStatus = "new";
    if (errors.length > 0) status = "error";
    else if (existingCodes.has(key)) status = updateExisting ? "update" : "skip";

    rows.push({
      row,
      status,
      errors,
      warnings,
      label: `${code || "?"} · ${name || "(sin nombre)"}`,
      payload:
        errors.length > 0
          ? undefined
          : {
              row,
              code,
              name,
              unit,
              cost: cost.value ?? 0,
              price_retail: price.value ?? 0,
              min_stock: min.value ?? 0,
              category: cellText(get("category")),
              stock: stock.value
            }
    });
  });
  return rows;
}

/* ------------------------------ proveedores y clientes ------------------------------ */

export interface SupplierPayload {
  row: number;
  name: string;
  category: string;
  phone: string;
  notes: string;
}

export interface CustomerPayload {
  row: number;
  name: string;
  phone: string;
  locality: string;
  province: string;
  notes: string;
}

function buildNamedRows<P extends { row: number; name: string }>(
  table: Table,
  mapping: ColumnMapping,
  existingNames: Set<string>,
  build: (row: number, get: (field: string) => string) => P
): ImportRow<P>[] {
  const c = mapping.columns;
  const rows: ImportRow<P>[] = [];
  const seen = new Set<string>();

  table.slice(1).forEach((raw, i) => {
    if (isEmptyRow(raw)) return;
    const row = i + 2;
    const errors: string[] = [];
    const get = (field: string) => (c[field] === undefined ? "" : cellText(raw[c[field]]));
    const name = get("name");
    if (!name) errors.push("Falta el nombre");
    const key = name.toLowerCase();
    if (name) {
      if (seen.has(key)) errors.push(`"${name}" está repetido en el archivo`);
      seen.add(key);
    }
    const status: RowStatus = errors.length > 0 ? "error" : existingNames.has(key) ? "skip" : "new";
    rows.push({ row, status, errors, warnings: [], label: name || "(sin nombre)", payload: errors.length > 0 ? undefined : build(row, get) });
  });
  return rows;
}

export function buildSupplierRows(table: Table, mapping: ColumnMapping, existingNames: Set<string>): ImportRow<SupplierPayload>[] {
  return buildNamedRows(table, mapping, existingNames, (row, get) => ({
    row,
    name: get("name"),
    category: get("category"),
    phone: get("phone"),
    notes: get("notes")
  }));
}

export function buildCustomerRows(table: Table, mapping: ColumnMapping, existingNames: Set<string>): ImportRow<CustomerPayload>[] {
  return buildNamedRows(table, mapping, existingNames, (row, get) => ({
    row,
    name: get("name"),
    phone: get("phone"),
    locality: get("locality"),
    province: get("province"),
    notes: get("notes")
  }));
}

export function summarize<P>(rows: ImportRow<P>[]) {
  return {
    total: rows.length,
    created: rows.filter((r) => r.status === "new").length,
    updated: rows.filter((r) => r.status === "update").length,
    skipped: rows.filter((r) => r.status === "skip").length,
    errors: rows.filter((r) => r.status === "error").length
  };
}

/* ------------------------------ plantillas ------------------------------ */

export const TEMPLATES: Record<ImportKind, { headers: string[]; rows: (string | number)[][] }> = {
  products: {
    headers: ["Código", "Nombre", "Unidad", "Costo", "Precio de venta", "Stock", "Stock mínimo", "Categoría"],
    rows: [
      [101, "Asado", "kg", 9500, 13800, 25.5, 5, "Vacuno"],
      [102, "Milanesa de nalga", "kg", 11000, 15900, 12, 3, "Vacuno"],
      [201, "Pollo entero", "kg", 3200, 4800, 40, 10, "Pollo"],
      [301, "Chorizo", "unidad", 700, 1100, 60, 20, "Cerdo"]
    ]
  },
  suppliers: {
    headers: ["Nombre", "Rubro", "Teléfono", "Notas"],
    rows: [
      ["Frigorífico Sur", "carne", "11 5555-1234", "Entrega los martes"],
      ["Avícola San José", "pollo", "11 4444-9876", ""]
    ]
  },
  customers: {
    headers: ["Nombre", "Teléfono", "Localidad", "Provincia", "Notas"],
    rows: [
      ["Restaurante La Esquina", "11 5555-0000", "La Plata", "Buenos Aires", "Paga a 15 días"],
      ["Rotisería Don Pedro", "", "Berisso", "Buenos Aires", ""]
    ]
  }
};
