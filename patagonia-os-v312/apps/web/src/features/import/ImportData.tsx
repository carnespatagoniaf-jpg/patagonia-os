import { useEffect, useMemo, useState } from "react";
import { useActiveBranch } from "../branches/BranchProvider";
import { downloadCsv, toCsv } from "../../lib/csv";
import { isSupabaseConfigured } from "../../lib/supabase";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listSuppliers } from "../purchases/suppliers-service";
import { listCustomers } from "../customers/customers-service";
import { importCustomers, importProducts, importSuppliers, type ImportCounts } from "./import-service";
import {
  FIELD_LABELS,
  TEMPLATES,
  buildCustomerRows,
  buildProductRows,
  buildSupplierRows,
  decodeFileBytes,
  mapColumns,
  parseDelimited,
  summarize,
  type Cell,
  type ImportKind,
  type ImportRow,
  type RowStatus,
  type Table
} from "./import-parse";

const KIND_LABELS: Record<ImportKind, string> = { products: "Productos", suppliers: "Proveedores", customers: "Clientes" };
const STATUS_LABELS: Record<RowStatus, string> = { new: "Nuevo", update: "Actualiza", skip: "Ya existe", error: "Error" };
const PREVIEW_LIMIT = 300;

export function ImportData() {
  const { branchId } = useActiveBranch();
  const [kind, setKind] = useState<ImportKind>("products");
  const [table, setTable] = useState<Table | null>(null);
  const [fileName, setFileName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [updateExisting, setUpdateExisting] = useState(false);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ counts: ImportCounts; kind: ImportKind } | null>(null);

  async function loadExisting(target: ImportKind) {
    if (!isSupabaseConfigured) return setExisting(new Set());
    try {
      if (target === "products") {
        if (!branchId) return;
        setExisting(new Set((await listProductsForBranch(branchId, true)).map((p) => p.code.toLowerCase())));
      } else if (target === "suppliers") {
        setExisting(new Set((await listSuppliers(true)).map((s) => s.name.trim().toLowerCase())));
      } else {
        setExisting(new Set((await listCustomers(true)).map((c) => c.name.trim().toLowerCase())));
      }
    } catch {
      setExisting(new Set());
    }
  }

  useEffect(() => {
    void loadExisting(kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, branchId]);

  function reset(nextKind?: ImportKind) {
    setTable(null);
    setFileName("");
    setPasteText("");
    setError("");
    setResult(null);
    if (nextKind) setKind(nextKind);
  }

  function downloadTemplate() {
    const t = TEMPLATES[kind];
    downloadCsv(`plantilla-${kind}.csv`, toCsv(t.headers, t.rows));
  }

  async function handleFile(file: File) {
    setError("");
    setResult(null);
    try {
      let data: Table;
      if (/\.xlsx$/i.test(file.name)) {
        const { readSheet } = await import("read-excel-file/browser");
        data = (await readSheet(file)) as Cell[][];
      } else if (/\.xls$/i.test(file.name)) {
        throw new Error('Ese es un Excel viejo (.xls). Abrilo en Excel y guardalo como "Libro de Excel (.xlsx)" o como "CSV" y subilo de nuevo.');
      } else {
        data = parseDelimited(decodeFileBytes(await file.arrayBuffer()));
      }
      if (data.length < 2) throw new Error("El archivo no tiene filas de datos (tiene que haber una fila de encabezados y al menos una fila más).");
      setFileName(file.name);
      setTable(data);
    } catch (err) {
      setTable(null);
      setError(err instanceof Error ? err.message : "No se pudo leer el archivo.");
    }
  }

  function handlePaste() {
    setError("");
    setResult(null);
    const data = parseDelimited(pasteText);
    if (data.length < 2) {
      setTable(null);
      setError("Pegá la fila de encabezados y al menos una fila de datos, copiadas desde Excel.");
      return;
    }
    setFileName("datos pegados");
    setTable(data);
  }

  const mapping = useMemo(() => (table ? mapColumns(kind, table[0]) : null), [table, kind]);

  const rows = useMemo((): ImportRow<unknown>[] => {
    if (!table || !mapping || mapping.missingRequired.length > 0) return [];
    if (kind === "products") return buildProductRows(table, mapping, existing, updateExisting);
    if (kind === "suppliers") return buildSupplierRows(table, mapping, existing);
    return buildCustomerRows(table, mapping, existing);
  }, [table, mapping, kind, existing, updateExisting]);

  const summary = summarize(rows);
  const sendable = rows.filter((r) => r.status === "new" || r.status === "update");

  async function handleImport() {
    if (busy || sendable.length === 0) return;
    if (!window.confirm(`Vas a importar ${sendable.length} ${KIND_LABELS[kind].toLowerCase()}${summary.errors > 0 ? ` (las ${summary.errors} filas con error no se importan)` : ""}. Queda registrado en Auditoría. ¿Seguir?`)) return;
    setBusy(true);
    setError("");
    try {
      const payloads = sendable.map((r) => r.payload);
      let counts: ImportCounts;
      if (kind === "products") {
        if (!branchId) throw new Error("Elegí una sucursal primero.");
        counts = await importProducts(branchId, payloads as never, updateExisting);
      } else if (kind === "suppliers") {
        counts = await importSuppliers(payloads as never);
      } else {
        if (!branchId) throw new Error("Elegí una sucursal primero.");
        counts = await importCustomers(branchId, payloads as never);
      }
      setResult({ counts, kind });
      setTable(null);
      setFileName("");
      setPasteText("");
      await loadExisting(kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo importar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">IMPORTAR</p>
          <h1>Importar desde Excel</h1>
          <p className="muted">Cargá muchos productos, proveedores o clientes de una sola vez, sin tipearlos uno por uno.</p>
        </div>
      </header>

      <section className="panel">
        <div className="import-tabs">
          {(Object.keys(KIND_LABELS) as ImportKind[]).map((k) => (
            <button key={k} className={k === kind ? "" : "secondary"} onClick={() => reset(k)}>{KIND_LABELS[k]}</button>
          ))}
        </div>

        <ol className="import-steps">
          <li>
            <strong>Bajá la plantilla</strong> y completala con tus datos (o usá tu propio archivo: reconocemos columnas como Código, Nombre, Precio, Costo, Stock, Categoría).
            <div style={{ marginTop: 6 }}><button className="secondary" onClick={downloadTemplate}>Descargar plantilla de {KIND_LABELS[kind].toLowerCase()}</button></div>
          </li>
          <li>
            <strong>Subí el archivo</strong> (Excel <code>.xlsx</code> o <code>.csv</code>) o <strong>pegá</strong> las filas copiadas desde Excel.
            <div className="import-inputs">
              <label className="import-file">
                <input type="file" accept=".xlsx,.xls,.csv,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }} />
              </label>
              <textarea
                placeholder="…o pegá acá los datos copiados desde Excel (con la fila de encabezados)"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={3}
              />
              <div><button className="secondary" disabled={!pasteText.trim()} onClick={handlePaste}>Leer datos pegados</button></div>
            </div>
          </li>
          <li><strong>Revisá la vista previa</strong> y tocá Importar. Nada se guarda hasta ese momento.</li>
        </ol>

        {error && <p className="message warning">{error}</p>}
        {result && (
          <p className="message">
            Listo. {KIND_LABELS[result.kind]}: {result.counts.created} creados
            {result.kind === "products" ? `, ${result.counts.updated} actualizados` : ""}, {result.counts.skipped} ya existían y se saltearon
            {result.kind === "products" && result.counts.stockAdjusted > 0 ? `; stock inicial cargado en ${result.counts.stockAdjusted}` : ""}.
          </p>
        )}
      </section>

      {table && mapping && (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title">
            <h2>Vista previa · {fileName}</h2>
            <button className="secondary" onClick={() => reset()}>Empezar de nuevo</button>
          </div>

          <p style={{ margin: "0 0 6px", fontSize: 14 }}>
            <strong>Columnas reconocidas:</strong>{" "}
            {Object.keys(mapping.columns).map((f) => FIELD_LABELS[f]).join(", ") || "ninguna"}
            {mapping.ignored.length > 0 && <span className="muted"> · Se ignoran: {mapping.ignored.join(", ")}</span>}
          </p>

          {mapping.missingRequired.length > 0 ? (
            <p className="message warning">
              Falta la columna {mapping.missingRequired.map((f) => `"${FIELD_LABELS[f]}"`).join(" y ")}. Agregala en la primera fila del archivo (podés usar la plantilla) y volvelo a subir.
            </p>
          ) : (
            <>
              {kind === "products" && (
                <label className="price-tools-check" style={{ margin: "6px 0" }}>
                  <input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} />
                  Actualizar los productos que ya existen (nombre, costo, precio, mínimo y categoría; nunca la unidad)
                </label>
              )}
              {kind === "products" && mapping.columns.stock !== undefined && (
                <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
                  La columna Stock deja el stock de cada producto en ese valor, en la sucursal activa.
                </p>
              )}

              <div className="import-summary">
                <span className="import-chip import-new">{summary.created} nuevos</span>
                {kind === "products" && <span className="import-chip import-update">{summary.updated} se actualizan</span>}
                <span className="import-chip import-skip">{summary.skipped} ya existen</span>
                <span className="import-chip import-error">{summary.errors} con error</span>
              </div>

              <div className="import-preview">
                <table className="data-table">
                  <thead>
                    <tr><th>Fila</th><th>Dato</th><th>Estado</th><th>Detalle</th></tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, PREVIEW_LIMIT).map((r) => (
                      <tr key={r.row}>
                        <td>{r.row}</td>
                        <td>{r.label}</td>
                        <td><span className={`import-chip import-${r.status}`}>{STATUS_LABELS[r.status]}</span></td>
                        <td className="muted" style={{ fontSize: 12 }}>{[...r.errors, ...r.warnings].join(" · ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > PREVIEW_LIMIT && <p className="muted" style={{ padding: 8 }}>Mostrando las primeras {PREVIEW_LIMIT} de {rows.length} filas (se importan todas).</p>}
              </div>

              {summary.errors > 0 && <p className="muted" style={{ fontSize: 13 }}>Las filas con error no se importan. Corregilas en el archivo y subilo de nuevo cuando quieras.</p>}

              <button className="price-tools-apply" disabled={busy || sendable.length === 0} onClick={() => void handleImport()}>
                {busy ? "Importando…" : sendable.length > 0 ? `Importar ${sendable.length} ${KIND_LABELS[kind].toLowerCase()}` : "No hay filas para importar"}
              </button>
            </>
          )}
        </section>
      )}
    </>
  );
}
