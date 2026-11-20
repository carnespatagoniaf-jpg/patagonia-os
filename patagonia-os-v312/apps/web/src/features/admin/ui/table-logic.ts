/**
 * Lógica pura de la tabla del panel (buscar, filtrar, ordenar, exportar). Sin React ni Supabase, para poder testearla.
 */

/** Minúsculas y sin acentos: "Río Gallegos" se encuentra escribiendo "rio gallegos". */
export function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Todas las palabras buscadas tienen que aparecer (en cualquier orden) en el texto de la fila. */
export function matchesSearch(haystack: string, query: string): boolean {
  const words = normalizeText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = normalizeText(haystack);
  return words.every((w) => text.includes(w));
}

export type SortValue = string | number | null | undefined;
export type SortDir = "asc" | "desc";

/** Compara dos valores: números como números, textos en orden alfabético español; vacíos siempre al final. */
export function compareValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const emptyA = a === null || a === undefined || a === "";
  const emptyB = b === null || b === undefined || b === "";
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  const sign = dir === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * sign;
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" }) * sign;
}

/** Ordena sin cambiar el arreglo original; a igual valor respeta el orden en que venían. */
export function sortRows<T>(rows: T[], value: (row: T) => SortValue, dir: SortDir): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => compareValues(value(x.row), value(y.row), dir) || x.index - y.index)
    .map((x) => x.row);
}

/** Próximo estado al tocar el encabezado de una columna: primero asc, después desc, después sin orden. */
export function nextSort(current: { key: string; dir: SortDir } | null, key: string, firstDir: SortDir = "asc"): { key: string; dir: SortDir } | null {
  if (!current || current.key !== key) return { key, dir: firstDir };
  if (current.dir === firstDir) return { key, dir: firstDir === "asc" ? "desc" : "asc" };
  return null;
}
