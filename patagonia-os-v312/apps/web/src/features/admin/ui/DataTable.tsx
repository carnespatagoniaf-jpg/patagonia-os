import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Search, SearchX } from "lucide-react";
import { downloadCsv, toCsv } from "../../../lib/csv";
import { BRAND } from "../../../lib/brand";
import { Button, EmptyState, Input, Skeleton } from "./components";
import { matchesSearch, nextSort, sortRows, type SortDir, type SortValue } from "./table-logic";

export interface Column<T> {
  key: string;
  header: string;
  /** Lo que se ve en la celda. */
  render: (row: T) => ReactNode;
  /** Valor para ordenar. Sin esto, la columna no se puede ordenar. */
  sortValue?: (row: T) => SortValue;
  /** Primer orden al tocar el encabezado (deuda, días sin vender: primero el mayor). */
  firstDir?: SortDir;
  /** Valor para el Excel. Sin esto, se usa sortValue; si tampoco hay, la columna no se exporta. */
  csvValue?: (row: T) => string | number;
  align?: "left" | "right";
  /** Se esconde en pantallas chicas: "md" ≤1024px (tablet), "sm" ≤600px (celular). */
  hideOn?: "md" | "sm";
  /** Solo va al Excel, no se ve en la tabla. */
  csvOnly?: boolean;
  /** La columna principal: en el celular es el título de la tarjeta. */
  main?: boolean;
}

export interface TableFilter<T> {
  key: string;
  label: string;
  test: (row: T) => boolean;
}

/**
 * Tabla del panel con buscador, filtros rápidos, orden por columna y bajada a Excel.
 * En el celular cada fila se convierte en una tarjeta.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  searchText,
  matches,
  searchPlaceholder = "Buscar…",
  filters,
  defaultSort,
  exportName,
  loading,
  onRowClick,
  emptyTitle = "Todavía no hay nada acá",
  emptyText,
  toolbar
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** Texto donde busca el buscador (nombre, dueño, ciudad…). Sin esto no hay buscador. */
  searchText?: (row: T) => string;
  /** Búsqueda propia (por ejemplo, por número de cliente o teléfono). Reemplaza a searchText para filtrar. */
  matches?: (row: T, query: string) => boolean;
  searchPlaceholder?: string;
  filters?: TableFilter<T>[];
  defaultSort?: { key: string; dir: SortDir };
  /** Nombre del archivo de Excel, sin extensión. Sin esto no hay botón de bajar. */
  exportName?: string;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyText?: ReactNode;
  /** Botones extra a la derecha del buscador. */
  toolbar?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [filterKey, setFilterKey] = useState<string>("all");
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(defaultSort ?? null);

  const searched = useMemo(
    () => (matches ? rows.filter((r) => matches(r, query)) : searchText ? rows.filter((r) => matchesSearch(searchText(r), query)) : rows),
    [rows, searchText, matches, query]
  );
  const counts = useMemo(() => Object.fromEntries((filters ?? []).map((f) => [f.key, searched.filter(f.test).length])), [filters, searched]);
  const visible = useMemo(() => {
    const filter = filters?.find((f) => f.key === filterKey);
    const filtered = filter ? searched.filter(filter.test) : searched;
    const col = sort ? columns.find((c) => c.key === sort.key) : undefined;
    return col?.sortValue && sort ? sortRows(filtered, col.sortValue, sort.dir) : filtered;
  }, [searched, filters, filterKey, sort, columns]);

  function exportCsv() {
    const cols = columns.filter((c) => c.csvValue || c.sortValue);
    const data = visible.map((r) => cols.map((c) => (c.csvValue ? c.csvValue(r) : c.sortValue!(r) ?? "")));
    const today = new Date().toISOString().slice(0, 10);
    downloadCsv(`${BRAND.filePrefix}-${exportName}-${today}.csv`, toCsv(cols.map((c) => c.header), data as (string | number)[][]));
  }

  const shown = columns.filter((c) => !c.csvOnly);
  const hideClass = (c: Column<T>) => (c.hideOn === "md" ? "pa-hide-md" : c.hideOn === "sm" ? "pa-hide-sm" : "");
  const filtered = query.trim() !== "" || filterKey !== "all";

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      {(searchText || matches || exportName || toolbar) && (
        <div className="pa-table-tools">
          {(searchText || matches) && (
            <div className="pa-search">
              <Search size={16} aria-hidden />
              <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} aria-label="Buscar" />
            </div>
          )}
          {toolbar}
          {exportName && <Button variant="secondary" icon={Download} onClick={exportCsv} disabled={visible.length === 0}>Bajar a Excel</Button>}
        </div>
      )}

      {filters && filters.length > 0 && (
        <div className="pa-chips" role="group" aria-label="Filtros">
          <button type="button" className="pa-chip" aria-pressed={filterKey === "all"} onClick={() => setFilterKey("all")}>
            Todos <span className="pa-chip-count">{searched.length}</span>
          </button>
          {filters.map((f) => (
            <button key={f.key} type="button" className="pa-chip" aria-pressed={filterKey === f.key} onClick={() => setFilterKey(f.key)}>
              {f.label} <span className="pa-chip-count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="pa-card"><Skeleton lines={5} /></div>
      ) : visible.length === 0 ? (
        <div className="pa-card">
          {filtered ? (
            <EmptyState icon={SearchX} title="No hay resultados" action={<Button variant="secondary" size="sm" onClick={() => { setQuery(""); setFilterKey("all"); }}>Ver todos</Button>}>
              Nada coincide con la búsqueda o el filtro.
            </EmptyState>
          ) : (
            <EmptyState title={emptyTitle}>{emptyText}</EmptyState>
          )}
        </div>
      ) : (
        <div className="pa-table-wrap">
          <table className="pa-table">
            <thead>
              <tr>
                {shown.map((c) => {
                  const active = sort?.key === c.key;
                  const SortIcon = !active ? ArrowUpDown : sort!.dir === "asc" ? ArrowUp : ArrowDown;
                  return (
                    <th key={c.key} className={[c.align === "right" ? "num" : "", hideClass(c)].filter(Boolean).join(" ") || undefined} aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
                      {c.sortValue ? (
                        <button type="button" className="pa-th-sort" data-active={active} onClick={() => setSort(nextSort(sort, c.key, c.firstDir))}>
                          {c.header} <SortIcon size={12} aria-hidden style={{ opacity: active ? 1 : 0.45 }} />
                        </button>
                      ) : c.header}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={rowKey(row)} className={onRowClick ? "clickable" : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                  {shown.map((c) => (
                    <td key={c.key} data-label={c.header} className={[c.align === "right" ? "num" : "", hideClass(c), c.main ? "pa-cell-main" : ""].filter(Boolean).join(" ") || undefined}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {visible.length > 0 && (
        <div className="pa-table-foot">
          <span>{visible.length === rows.length ? `${rows.length} en total` : `Mostrando ${visible.length} de ${rows.length}`}</span>
        </div>
      )}
    </div>
  );
}
