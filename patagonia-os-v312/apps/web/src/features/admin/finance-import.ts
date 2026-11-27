/**
 * Importar gastos a Finanzas del panel de plataforma desde un archivo (pedido del dueño, 27/11/2026: "cargá todo vos").
 * Lógica pura y testeada (finance-import.test.ts): leer el archivo y marcar lo que ya está cargado, para no repetirlo.
 *
 * Formato: CSV con ";" (o ","), encabezado con columnas fecha, categoria, detalle, monto (en cualquier orden;
 * se aceptan "categoría", "descripción", "importe"). Fecha AAAA-MM-DD o DD/MM/AAAA. Monto 1234.56 o 1.234,56.
 */

export interface ImportRow {
  /** Renglón del archivo (1 = el primero después del encabezado), para mostrar errores. */
  line: number;
  date: string;
  category: string;
  description: string;
  amount: number;
}

export interface ParseResult {
  rows: ImportRow[];
  errors: string[];
}

function normalize(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** "1.234,56" → 1234.56; "1234.56" → 1234.56; "$ -2.136,22" → 2136.22 (los gastos se guardan en positivo). */
export function parseMoney(raw: string): number {
  let s = raw.replace(/[$\s]/g, "").replace(/^-/, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  return Number(s);
}

/** AAAA-MM-DD o DD/MM/AAAA (también DD-MM-AAAA) → AAAA-MM-DD; null si no es una fecha válida. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

const COLUMNS: Record<string, keyof Omit<ImportRow, "line">> = {
  fecha: "date", date: "date", dia: "date",
  categoria: "category", category: "category", rubro: "category",
  detalle: "description", descripcion: "description", concepto: "description", description: "description",
  monto: "amount", importe: "amount", amount: "amount", total: "amount"
};

export function parseExpenseFile(text: string): ParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { rows: [], errors: ["El archivo está vacío."] };
  const sep = lines[0].includes(";") ? ";" : ",";
  const head = lines[0].split(sep).map((h) => COLUMNS[normalize(h).replace(/[^a-z]/g, "")]);
  const missing = (["date", "amount"] as const).filter((k) => !head.includes(k));
  if (missing.length) return { rows: [], errors: ["El encabezado tiene que tener al menos las columnas fecha y monto."] };
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  lines.slice(1).forEach((l, i) => {
    const cells = l.split(sep);
    const get = (k: keyof Omit<ImportRow, "line">) => {
      const idx = head.indexOf(k);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };
    const date = parseDate(get("date"));
    const amount = parseMoney(get("amount"));
    if (!date) return errors.push(`Renglón ${i + 1}: la fecha "${get("date")}" no se entiende.`);
    if (!Number.isFinite(amount) || amount <= 0) return errors.push(`Renglón ${i + 1}: el monto "${get("amount")}" no se entiende.`);
    rows.push({ line: i + 1, date, category: get("category") || "Varios", description: get("description"), amount: Math.round(amount * 100) / 100 });
  });
  return { rows, errors };
}

export interface ExistingMovement {
  date: string;
  amount: number;
  kind: string;
  description: string | null;
}

/**
 * Qué renglones ya están cargados: mismo día y mismo monto (al centavo) que un gasto que ya existe. Cada gasto que ya
 * existe "tapa" un solo renglón, así dos cargos iguales el mismo día (pasa con los impuestos de Facebook) no se pierden
 * si solo uno estaba cargado.
 */
export function markDuplicates(rows: ImportRow[], existing: ExistingMovement[]): Set<number> {
  const pool = new Map<string, number>();
  for (const m of existing) {
    if (m.kind !== "gasto") continue;
    const key = `${m.date}|${Math.round(m.amount * 100)}`;
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  const dup = new Set<number>();
  for (const r of rows) {
    const key = `${r.date}|${Math.round(r.amount * 100)}`;
    const left = pool.get(key) ?? 0;
    if (left > 0) {
      dup.add(r.line);
      pool.set(key, left - 1);
    }
  }
  return dup;
}

/** Meses (AAAA-MM) que toca el archivo, para traer lo que ya está cargado en cada uno. */
export function monthsOf(rows: ImportRow[]): string[] {
  return [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
}
