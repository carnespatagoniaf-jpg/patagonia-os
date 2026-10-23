// Lectura de "Mis Comprobantes Recibidos" de ARCA (CSV o Excel) → comprobantes
// de compra listos para import_purchase_vouchers. Lógica pura, sin Supabase.
// ARCA cambió el archivo con el tiempo: el viejo trae un solo "Imp. Neto
// Gravado" + "IVA"; el nuevo, neto e IVA por alícuota ("IVA 21%",
// "Imp. Neto Gravado IVA 21%"). Se aceptan los dos, con o sin filas de título arriba.
import type { Cell, Table } from "../import/import-parse";
import { purchaseDiscriminatesVat, VOUCHER_TYPE_LABELS, type VatLine } from "./accounting-view";

export interface ImportedVoucher {
  row: number;
  voucher_date: string;
  voucher_type: number;
  point_of_sale: number;
  number: number;
  cae: string | null;
  seller_doc_type: number;
  seller_doc: string;
  seller_name: string;
  vat_lines: VatLine[];
  no_taxed: number;
  exempt: number;
  other_taxes: number;
  total: number;
}

export interface ParsedRow {
  row: number;
  voucher?: ImportedVoucher;
  errors: string[];
  warnings: string[];
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const FIELDS: Record<string, string[]> = {
  date: ["fecha", "fechadeemision", "fechaemision", "fechacomprobante"],
  type: ["tipo", "tipodecomprobante", "tipocomprobante", "tipodecbte"],
  pos: ["puntodeventa", "ptovta", "ptodeventa", "puntoventa"],
  number: ["numerodesde", "nrodesde", "numero", "numerodecomprobante", "nrocomprobante"],
  cae: ["codautorizacion", "codigodeautorizacion", "cae", "caecaea"],
  docType: ["tipodocemisor", "tipodocumentoemisor", "tipodoc"],
  doc: ["nrodocemisor", "numerodocemisor", "nrodocumentoemisor", "cuitemisor", "nrodoc"],
  name: ["denominacionemisor", "razonsocialemisor", "denominacion", "emisor"],
  currency: ["moneda"],
  exchange: ["tipocambio", "tipodecambio"],
  net: ["impnetogravado", "netogravado", "impnetogravadototal", "totalnetogravado"],
  noTaxed: ["impnetonogravado", "netonogravado", "nogravado"],
  exempt: ["impopexentas", "operacionesexentas", "exento", "exentas"],
  other: ["otrostributos"],
  vat: ["iva", "totaliva", "impiva", "importeiva"],
  total: ["imptotal", "importetotal", "total"]
};

/** Columnas de neto e IVA por alícuota del archivo nuevo ("IVA 10,5%" → iva105). */
const RATE_KEYS: Record<string, number> = { "0": 0, "25": 2.5, "5": 5, "105": 10.5, "21": 21, "27": 27 };

interface Columns {
  fields: Record<string, number>;
  rateVat: Record<number, number>;
  rateNet: Record<number, number>;
}

function mapHeader(row: Cell[]): Columns {
  const fields: Record<string, number> = {};
  const rateVat: Record<number, number> = {};
  const rateNet: Record<number, number> = {};
  row.forEach((cell, i) => {
    const h = norm(cellString(cell));
    if (!h) return;
    const vatRate = h.match(/^iva(\d+)$/);
    if (vatRate && RATE_KEYS[vatRate[1]] !== undefined) {
      rateVat[RATE_KEYS[vatRate[1]]] = i;
      return;
    }
    const netRate = h.match(/^(?:imp)?netogravadoiva(\d+)$/);
    if (netRate && RATE_KEYS[netRate[1]] !== undefined) {
      rateNet[RATE_KEYS[netRate[1]]] = i;
      return;
    }
    for (const [field, names] of Object.entries(FIELDS)) {
      if (fields[field] === undefined && names.includes(h)) {
        fields[field] = i;
        return;
      }
    }
  });
  return { fields, rateVat, rateNet };
}

function cellString(cell: Cell): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell).trim();
}

/** Importe: número de Excel, "1234,56", "1.234,56" o "1234.56". Vacío = 0. */
export function amountCell(cell: Cell): number {
  if (typeof cell === "number") return cell;
  const s = cellString(cell).replace(/\$/g, "").replace(/\s/g, "");
  if (!s) return 0;
  let normalized = s;
  if (s.includes(",")) normalized = s.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

/** Fecha: Date de Excel, "dd/mm/aaaa", "aaaa-mm-dd" o número de serie de Excel. */
export function dateCell(cell: Cell): string | null {
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === "number" && cell > 20000 && cell < 80000) {
    return new Date(Math.round((cell - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  }
  const s = cellString(cell);
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const TYPE_BY_NAME = new Map(Object.entries(VOUCHER_TYPE_LABELS).map(([code, label]) => [norm(label), Number(code)]));

/** "1 - Factura A", "1", "Factura A" o "011" → código de ARCA. */
export function voucherTypeCell(cell: Cell): number | null {
  if (typeof cell === "number") return cell;
  const s = cellString(cell);
  const lead = s.match(/^0*(\d{1,3})\b/);
  if (lead) return Number(lead[1]);
  return TYPE_BY_NAME.get(norm(s)) ?? null;
}

const RATES = [2.5, 5, 10.5, 21, 27];

/** Alícuota más cercana a IVA/neto (para el archivo viejo, que no la trae). */
function guessRate(net: number, vat: number): number | null {
  if (net <= 0) return null;
  const pct = (vat / net) * 100;
  const best = RATES.reduce((a, b) => (Math.abs(b - pct) < Math.abs(a - pct) ? b : a));
  return Math.abs(best - pct) <= 0.3 ? best : null;
}

/** Busca la fila de encabezados (ARCA pone un título arriba) en las primeras 15 filas. */
export function findHeaderRow(table: Table): number {
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const cols = mapHeader(table[i]);
    if (cols.fields.type !== undefined && cols.fields.number !== undefined && cols.fields.total !== undefined && cols.fields.doc !== undefined) return i;
  }
  return -1;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function parseMisComprobantes(table: Table): { rows: ParsedRow[]; headerFound: boolean; perRate: boolean } {
  const headerIndex = findHeaderRow(table);
  if (headerIndex < 0) return { rows: [], headerFound: false, perRate: false };
  const cols = mapHeader(table[headerIndex]);
  const perRate = Object.keys(cols.rateVat).length > 0;
  const get = (raw: Cell[], field: string): Cell => (cols.fields[field] === undefined ? null : raw[cols.fields[field]]);
  const rows: ParsedRow[] = [];

  table.slice(headerIndex + 1).forEach((raw, i) => {
    if (!raw || raw.every((c) => cellString(c) === "")) return;
    const row = headerIndex + i + 2;
    const errors: string[] = [];
    const warnings: string[] = [];

    const date = dateCell(get(raw, "date"));
    const type = voucherTypeCell(get(raw, "type"));
    const pos = Number(cellString(get(raw, "pos")).replace(/\D/g, "") || "0");
    const number = Number(cellString(get(raw, "number")).replace(/\D/g, "") || "0");
    const doc = cellString(get(raw, "doc")).replace(/\D/g, "");
    const docTypeText = cellString(get(raw, "docType"));
    const docType = /cuit/i.test(docTypeText) || docTypeText === "" ? 80 : Number(docTypeText.replace(/\D/g, "")) || 80;
    const name = cellString(get(raw, "name"));
    const currency = cellString(get(raw, "currency")).toUpperCase();
    const exchange = amountCell(get(raw, "exchange"));
    const factor = currency && currency !== "PES" && currency !== "$" && exchange > 0 ? exchange : 1;
    const money = (cell: Cell) => round2(Math.abs(amountCell(cell)) * factor);

    if (!date) errors.push("Falta la fecha o no se entiende");
    if (type === null || !VOUCHER_TYPE_LABELS[type]) errors.push(`Tipo de comprobante no reconocido: "${cellString(get(raw, "type"))}"`);
    if (!number) errors.push("Falta el número");
    if (!doc) errors.push("Falta el CUIT del emisor");
    const total = money(get(raw, "total"));
    if (!Number.isFinite(total) || total <= 0) errors.push("El total no es un número");
    if (factor !== 1) warnings.push(`En ${currency}: se pasó a pesos con el tipo de cambio ${exchange}`);

    const lines: VatLine[] = [];
    if (type !== null && purchaseDiscriminatesVat(type)) {
      if (perRate) {
        for (const rate of [0, 2.5, 5, 10.5, 21, 27]) {
          const net = cols.rateNet[rate] === undefined ? 0 : money(raw[cols.rateNet[rate]]);
          const vat = cols.rateVat[rate] === undefined ? 0 : money(raw[cols.rateVat[rate]]);
          if (net !== 0 || vat !== 0) lines.push({ rate, net, vat });
        }
      } else {
        const net = money(get(raw, "net"));
        const vat = money(get(raw, "vat"));
        if (net !== 0 || vat !== 0) {
          const rate = guessRate(net, vat);
          if (rate === null) {
            lines.push({ rate: 21, net, vat });
            warnings.push("No trae la alícuota y el IVA no coincide con una sola: revisala");
          } else {
            lines.push({ rate, net, vat });
          }
        }
      }
    }

    const voucher: ImportedVoucher | undefined =
      errors.length > 0
        ? undefined
        : {
            row,
            voucher_date: date!,
            voucher_type: type!,
            point_of_sale: pos,
            number,
            cae: cellString(get(raw, "cae")) || null,
            seller_doc_type: docType,
            seller_doc: doc,
            seller_name: name || doc,
            vat_lines: lines,
            no_taxed: purchaseDiscriminatesVat(type!) ? money(get(raw, "noTaxed")) : 0,
            exempt: purchaseDiscriminatesVat(type!) ? money(get(raw, "exempt")) : 0,
            other_taxes: purchaseDiscriminatesVat(type!) ? money(get(raw, "other")) : 0,
            total
          };
    rows.push({ row, voucher, errors, warnings });
  });
  return { rows, headerFound: true, perRate };
}
