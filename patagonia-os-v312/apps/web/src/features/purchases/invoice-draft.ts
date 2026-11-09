/**
 * "Leer factura con foto" (Compras). Lógica pura: toma lo que devolvió la
 * Edge Function invoice-reader (los datos del papel) y lo convierte en
 * renglones del formulario de compra, eligiendo el producto y el proveedor de
 * la empresa que corresponden. No guarda nada: la persona revisa y confirma.
 */

export interface ReadInvoiceItem {
  description: string;
  quantity: number;
  unit: "kg" | "unit";
  unitPrice: number;
  lineTotal: number;
}

export interface ReadInvoice {
  supplierName: string;
  supplierTaxId: string;
  date: string;
  invoiceNumber: string;
  items: ReadInvoiceItem[];
  subtotal: number;
  taxTotal: number;
  total: number;
  warnings: string[];
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Lee la respuesta de la Edge Function sin confiar en su forma. */
export function parseReadInvoice(raw: unknown): ReadInvoice {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    supplierName: str(o.supplier_name),
    supplierTaxId: str(o.supplier_tax_id).replace(/\D/g, ""),
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(o.date)) ? str(o.date) : "",
    invoiceNumber: str(o.invoice_number),
    items: items
      .map((it) => {
        const i = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
        const quantity = num(i.quantity);
        const lineTotal = num(i.line_total);
        let unitPrice = num(i.unit_price);
        // Si el papel no trae el precio unitario pero sí el importe, se calcula.
        if (unitPrice <= 0 && quantity > 0 && lineTotal > 0) unitPrice = Math.round((lineTotal / quantity) * 100) / 100;
        return {
          description: str(i.description),
          quantity,
          unit: i.unit === "unit" ? ("unit" as const) : ("kg" as const),
          unitPrice,
          lineTotal
        };
      })
      .filter((it) => it.description !== "" || it.quantity > 0),
    subtotal: num(o.subtotal),
    taxTotal: num(o.tax_total),
    total: num(o.total),
    warnings: Array.isArray(o.warnings) ? o.warnings.map(str).filter(Boolean) : []
  };
}

/** Minúsculas, sin acentos ni signos: "Lomos c/Cordón" → "lomos c cordon". */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const FILLER = new Set(["de", "del", "la", "el", "los", "las", "x", "kg", "kgs", "por", "y", "al", "a"]);

function singular(token: string): string {
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function tokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((t) => t && !FILLER.has(t))
    .map(singular);
}

/** ¿Están todas las palabras de `needle` en `hay`, en el mismo orden? */
function inOrder(needle: string[], hay: string[]): boolean {
  let at = 0;
  for (const word of needle) {
    const found = hay.indexOf(word, at);
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

export interface MatchableProduct {
  id: string;
  name: string;
  unit?: string;
}

/**
 * El producto de la empresa que corresponde a un renglón del papel, o null.
 * Gana el producto cuyas palabras están TODAS en el renglón y en el mismo orden
 * ("NALGA SIN TAPA" → Nalga, nunca "Tapa de nalga"); entre varios, el de más
 * palabras ("BIFE ANCHO C/TAPA" → Bife ancho, no Bife). Si dos empatan, no se
 * elige ninguno: mejor que la persona lo elija a que se cargue mal el stock.
 * Las ofertas y combos no se compran, así que nunca se proponen.
 */
export function matchProduct(description: string, products: MatchableProduct[]): string | null {
  const hay = tokens(description);
  if (hay.length === 0) return null;
  let best: { id: string; size: number } | null = null;
  let tie = false;
  for (const product of products) {
    const norm = normalizeText(product.name);
    if (norm.startsWith("oferta") || norm.startsWith("combo")) continue;
    const needle = tokens(product.name);
    if (needle.length === 0 || !inOrder(needle, hay)) continue;
    if (!best || needle.length > best.size) {
      best = { id: product.id, size: needle.length };
      tie = false;
    } else if (needle.length === best.size && product.id !== best.id) {
      tie = true;
    }
  }
  return best && !tie ? best.id : null;
}

export interface MatchableSupplier {
  id: string;
  name: string;
  taxId?: string | null;
}

const LEGAL = new Set(["sa", "srl", "sas", "s", "a", "r", "l", "sociedad", "anonima", "hnos", "hno", "cia"]);

function supplierTokens(value: string): string[] {
  return tokens(value).filter((t) => !LEGAL.has(t));
}

/**
 * El proveedor de la empresa que emitió el comprobante: primero por CUIT (si
 * el proveedor lo tiene cargado), después por nombre ("FRIGORIFICO MERLO S.A."
 * → "Carnes Merlo" no alcanza, "Frigorífico Merlo" sí: tienen que coincidir
 * todas las palabras del más corto). Si hay dudas, null.
 */
export function matchSupplier(invoice: Pick<ReadInvoice, "supplierName" | "supplierTaxId">, suppliers: MatchableSupplier[]): string | null {
  const cuit = invoice.supplierTaxId.replace(/\D/g, "");
  if (cuit.length === 11) {
    const byCuit = suppliers.filter((s) => (s.taxId ?? "").replace(/\D/g, "") === cuit);
    if (byCuit.length === 1) return byCuit[0].id;
  }
  const read = supplierTokens(invoice.supplierName);
  if (read.length === 0) return null;
  const hits = suppliers.filter((s) => {
    const own = supplierTokens(s.name);
    if (own.length === 0) return false;
    const [short, long] = own.length <= read.length ? [own, read] : [read, own];
    return short.every((t) => long.includes(t));
  });
  return hits.length === 1 ? hits[0].id : null;
}

/** Cantidad con coma decimal para el casillero ("38,5"). */
export function quantityText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  return String(Math.round(value * 1000) / 1000).replace(".", ",");
}

/** Precio con coma decimal para el casillero ("14315,25"); igual que amountInputText. */
export function priceText(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  return String(Math.round(value * 100) / 100).replace(".", ",");
}

export interface InvoiceDraftLine {
  productId: string;
  description: string;
  quantity: string;
  unit: "kg" | "unit";
  unitPrice: string;
}

export function draftLinesFromInvoice(invoice: ReadInvoice, products: MatchableProduct[]): InvoiceDraftLine[] {
  return invoice.items.map((item) => {
    const productId = matchProduct(item.description, products) ?? "";
    return {
      productId,
      description: productId ? "" : item.description,
      quantity: quantityText(item.quantity),
      unit: item.unit,
      unitPrice: priceText(item.unitPrice)
    };
  });
}

export interface InvoiceCheck {
  /** Suma de cantidad × precio de los renglones leídos. */
  linesTotal: number;
  /** Lo que tendría que dar según el papel (subtotal sin impuestos, o el total). */
  expected: number;
  ok: boolean;
  /** Avisos para mostrar: renglones que no cierran, total que no cierra. */
  notes: string[];
}

/**
 * Controla que lo leído cierre: cada renglón (cantidad × precio ≈ importe) y
 * la suma contra el subtotal del papel (o el total, si no discrimina impuestos).
 * Tolerancia: 1% o $100, lo que sea mayor (redondeos de la factura).
 */
export function checkInvoice(invoice: ReadInvoice): InvoiceCheck {
  const notes: string[] = [];
  let linesTotal = 0;
  invoice.items.forEach((item, index) => {
    const calc = item.quantity * item.unitPrice;
    linesTotal += calc;
    if (item.lineTotal > 0 && Math.abs(calc - item.lineTotal) > Math.max(1, item.lineTotal * 0.01)) {
      notes.push(`Renglón ${index + 1} (${item.description || "sin nombre"}): cantidad × precio no da el importe del papel. Revisalo.`);
    }
  });
  linesTotal = Math.round(linesTotal * 100) / 100;
  const expected = invoice.subtotal > 0 ? invoice.subtotal : invoice.total;
  const ok = expected <= 0 || Math.abs(linesTotal - expected) <= Math.max(100, expected * 0.01);
  if (!ok) notes.push(`Los renglones suman ${Math.round(linesTotal)} y el papel dice ${Math.round(expected)}. Revisá que no falte o sobre un renglón.`);
  return { linesTotal, expected, ok, notes };
}
