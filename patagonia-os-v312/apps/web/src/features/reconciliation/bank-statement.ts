import { normalizeHeader, parseNumberCell, type Cell, type Table } from "../import/import-parse";

/**
 * Lectura del resumen de CUALQUIER banco o billetera (Excel/CSV) para la
 * conciliación. No hay un lector por banco: se busca solo la fila de
 * encabezados y qué columna es cada cosa (por nombres típicos), la persona
 * lo confirma o corrige la primera vez, y ese formato se guarda para la
 * cuenta. Lógica pura (sin Supabase) para poder testearla.
 *
 * Signo del importe: positivo = entra plata a la cuenta, negativo = sale.
 */

export type BankField = "date" | "description" | "amount" | "debit" | "credit" | "reference" | "balance";

export const BANK_FIELD_LABELS: Record<BankField, string> = {
  date: "Fecha",
  description: "Detalle / concepto",
  amount: "Importe (con signo)",
  debit: "Débito (sale plata)",
  credit: "Crédito (entra plata)",
  reference: "Nro. de operación / comprobante",
  balance: "Saldo"
};

export type DateOrder = "dmy" | "mdy" | "ymd";

export interface BankMapping {
  /** Índice (desde 0) de la fila de encabezados. */
  headerRow: number;
  columns: Partial<Record<BankField, number>>;
  dateOrder: DateOrder;
}

export interface BankLine {
  /** Fila del archivo (desde 1, como la ve la persona en Excel). */
  row: number;
  date: string;
  description: string;
  amount: number;
  reference: string | null;
  balance: number | null;
  /** Identifica la línea para no importarla dos veces (mismo resumen o resúmenes que se pisan). */
  key: string;
}

export interface SkippedRow {
  row: number;
  reason: string;
}

const SYNONYMS: Record<BankField, string[]> = {
  date: [
    "fecha", "fechaoperacion", "fechadeoperacion", "fechamovimiento", "fechadelmovimiento", "fechacontable",
    "fechaorigen", "fechadeliberacion", "fechaliberacion", "fechadeaprobacion", "fechaacreditacion", "fechadeacreditacion",
    "fechavalor", "dia", "date", "releasedate", "transactiondate"
  ],
  description: [
    "descripcion", "concepto", "detalle", "movimiento", "leyenda", "descripciondelmovimiento", "detalledelmovimiento",
    "tipodemovimiento", "tipodeoperacion", "tipo", "operacion", "transactiontype", "description"
  ],
  amount: [
    "importe", "monto", "valor", "importeneto", "montoneto", "neto", "importeenpesos", "montoenpesos",
    "amount", "netamount", "transactionnetamount", "transactionamount", "settlementnetamount"
  ],
  debit: ["debito", "debitos", "debe", "egreso", "egresos", "salida", "salidas", "retiro", "retiros", "cargo", "cargos", "debit", "netdebitamount"],
  credit: ["credito", "creditos", "haber", "ingreso", "ingresos", "entrada", "entradas", "deposito", "depositos", "abono", "credit", "netcreditamount"],
  reference: [
    "referencia", "nrooperacion", "numerodeoperacion", "nrodeoperacion", "iddeoperacion", "idoperacion", "operacionnro",
    "comprobante", "nrocomprobante", "numerodecomprobante", "nrodecomprobante", "codigo", "codigodeoperacion",
    "referenceid", "sourceid", "operationid", "nro", "numero", "nroref", "id"
  ],
  balance: ["saldo", "saldoparcial", "saldodisponible", "saldocontable", "saldofinal", "balance", "partialbalance", "balanceamount"]
};

function matchField(header: Cell): BankField | null {
  const h = normalizeHeader(header);
  if (!h) return null;
  // Exacto primero ("fecha" antes que "fechavalor"), después "empieza con"
  // para encabezados tipo "Importe ($)" o "Débitos en pesos".
  for (const field of Object.keys(SYNONYMS) as BankField[]) {
    if (SYNONYMS[field].includes(h)) return field;
  }
  for (const field of Object.keys(SYNONYMS) as BankField[]) {
    if (SYNONYMS[field].some((s) => s.length >= 5 && h.startsWith(s))) return field;
  }
  return null;
}

/**
 * Busca la fila de encabezados (muchos bancos ponen arriba el nombre del
 * titular, CBU, período…) y arma el mapeo. Devuelve null si no encuentra
 * una fila con fecha e importe (o débito/crédito).
 */
export function guessBankMapping(table: Table): BankMapping | null {
  const maxScan = Math.min(table.length, 40);
  for (let r = 0; r < maxScan; r++) {
    const row = table[r] ?? [];
    const columns: Partial<Record<BankField, number>> = {};
    row.forEach((cell, index) => {
      const field = matchField(cell);
      if (field && columns[field] === undefined) columns[field] = index;
    });
    const hasMoney = columns.amount !== undefined || columns.debit !== undefined || columns.credit !== undefined;
    if (columns.date !== undefined && hasMoney) {
      // Si hay débito y crédito separados, esos mandan sobre un "importe" suelto.
      if (columns.debit !== undefined && columns.credit !== undefined) delete columns.amount;
      return { headerRow: r, columns, dateOrder: guessDateOrder(table.slice(r + 1), columns.date) };
    }
  }
  return null;
}

const MONTHS: Record<string, number> = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8,
  sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function validIso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Mira las primeras fechas para saber si vienen día/mes o mes/día (Argentina: día/mes). */
export function guessDateOrder(rows: Table, column: number | undefined): DateOrder {
  if (column === undefined) return "dmy";
  for (const row of rows.slice(0, 200)) {
    const text = typeof row[column] === "string" ? (row[column] as string).trim() : "";
    if (/^\d{4}[-/]/.test(text)) return "ymd";
    const m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/);
    if (m) {
      if (Number(m[1]) > 12) return "dmy";
      if (Number(m[2]) > 12) return "mdy";
    }
  }
  return "dmy";
}

/** Fecha de una celda en formato ISO (aaaa-mm-dd), o null si no es una fecha. */
export function parseBankDate(cell: Cell, order: DateOrder): string | null {
  if (cell === null || cell === undefined) return null;
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? null : validIso(cell.getFullYear(), cell.getMonth() + 1, cell.getDate());
  }
  if (typeof cell === "number") {
    // Número de serie de Excel (días desde 1899-12-30).
    if (cell < 30000 || cell > 80000) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(cell) * 86_400_000);
    return validIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const text = String(cell).trim().toLowerCase();
  if (!text) return null;

  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return validIso(Number(m[1]), Number(m[2]), Number(m[3]));

  m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    return order === "mdy" ? validIso(y, a, b) : validIso(y, b, a);
  }

  m = text.match(/^(\d{1,2})[-/. ]([a-z]{3})[a-z]*\.?[-/. ](\d{2,4})\b/);
  if (m && MONTHS[m[2]]) return validIso(Number(m[3]), MONTHS[m[2]], Number(m[1]));

  return null;
}

/**
 * Importe de una celda. Acepta "1.234,56", "1,234.56", "-1.234,56",
 * "(1.234,56)", "1.234,56-", "$ 1.234,56", "1.234,56 D" / "C".
 */
export function parseBankAmount(cell: Cell): number | null {
  if (cell === null || cell === undefined || cell === "") return null;
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (cell instanceof Date || typeof cell === "boolean") return null;

  let text = String(cell).replace(/ /g, " ").trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  const suffix = text.match(/\s*([dc])$/i);
  if (suffix) {
    negative = negative || suffix[1].toLowerCase() === "d";
    text = text.slice(0, suffix.index);
  }
  text = text.replace(/\$|ars|u\$s|usd/gi, "").replace(/\s+/g, "");
  if (text.endsWith("-")) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  }
  if (text.startsWith("+")) text = text.slice(1);
  const { value, invalid } = parseNumberCell(text, true);
  if (invalid || value === null) return null;
  return negative ? -value : value;
}

function cellText(cell: Cell): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell).replace(/\s+/g, " ").trim();
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

const BALANCE_ROW = /^(saldo\s+(anterior|inicial|final|al\b|del\s+periodo)|total(es)?\b|transporte\b)/i;

export function parseBankStatement(table: Table, mapping: BankMapping): { lines: BankLine[]; skipped: SkippedRow[] } {
  const lines: BankLine[] = [];
  const skipped: SkippedRow[] = [];
  const { columns } = mapping;
  const seen = new Map<string, number>();

  for (let r = mapping.headerRow + 1; r < table.length; r++) {
    const row = table[r] ?? [];
    const rowNumber = r + 1;
    if (row.every((c) => cellText(c) === "")) continue;

    const date = parseBankDate(columns.date !== undefined ? row[columns.date] : null, mapping.dateOrder);
    const description = columns.description !== undefined ? cellText(row[columns.description]) : "";

    let amount: number | null = null;
    if (columns.amount !== undefined) {
      amount = parseBankAmount(row[columns.amount]);
    } else {
      const debit = columns.debit !== undefined ? parseBankAmount(row[columns.debit]) : null;
      const credit = columns.credit !== undefined ? parseBankAmount(row[columns.credit]) : null;
      if (debit !== null || credit !== null) amount = Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
    }

    if (!date) {
      skipped.push({ row: rowNumber, reason: description ? `sin fecha ("${description.slice(0, 40)}")` : "sin fecha" });
      continue;
    }
    if (BALANCE_ROW.test(description)) {
      skipped.push({ row: rowNumber, reason: "fila de saldo o total" });
      continue;
    }
    if (amount === null || !Number.isFinite(amount)) {
      skipped.push({ row: rowNumber, reason: "sin importe" });
      continue;
    }
    amount = round2(amount);
    if (amount === 0) {
      skipped.push({ row: rowNumber, reason: "importe cero" });
      continue;
    }

    const referenceText = columns.reference !== undefined ? cellText(row[columns.reference]) : "";
    const reference = referenceText || null;
    const balance = columns.balance !== undefined ? parseBankAmount(row[columns.balance]) : null;

    // Dos líneas iguales el mismo día (ej. dos comisiones iguales) son
    // distintas: se numeran en el orden en que aparecen.
    const base = `${date}|${amount.toFixed(2)}|${reference ?? ""}|${normalizeHeader(description)}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);

    lines.push({ row: rowNumber, date, description, amount, reference, balance, key: `${base}|${occurrence}` });
  }
  return { lines, skipped };
}
