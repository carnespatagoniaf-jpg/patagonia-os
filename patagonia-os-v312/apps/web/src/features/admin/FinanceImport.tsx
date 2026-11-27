import { useMemo, useState } from "react";
import { Upload } from "lucide-react";
import { getFinanceOverview, saveFinanceMovement } from "./admin-service";
import type { FinAccount } from "./finance";
import { markDuplicates, monthsOf, parseExpenseFile, type ImportRow } from "./finance-import";
import { Alert, Badge, Button, Field, Select } from "./ui/components";
import { DataTable, type Column } from "./ui/DataTable";

const pesos = (v: number) => "$" + v.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fecha = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * "Importar gastos" de Finanzas (27/11/2026): subís un archivo (fecha, categoría, detalle, monto), elegís la cuenta de
 * donde salieron (por ejemplo la tarjeta) y se cargan todos juntos como gasto. Lo que ya está cargado (mismo día y
 * mismo monto) se marca y no se vuelve a cargar.
 */
export function FinanceImport({ accounts, onDone }: { accounts: FinAccount[]; onDone: (text: string) => void }) {
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dups, setDups] = useState<Set<number>>(new Set());
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [busy, setBusy] = useState<"" | "read" | "save">("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  async function readFile(file: File) {
    setBusy("read");
    setError("");
    setFileName(file.name);
    try {
      const parsed = parseExpenseFile(await file.text());
      setRows(parsed.rows);
      setErrors(parsed.errors);
      // Lo que ya está cargado en esos meses, para no repetirlo.
      const existing = (await Promise.all(monthsOf(parsed.rows).map((m) => getFinanceOverview(m)))).flatMap((o) => o.movements);
      setDups(markDuplicates(parsed.rows, existing.map((m) => ({ date: m.date, amount: m.amount, kind: m.kind, description: m.description }))));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo leer el archivo.");
    } finally {
      setBusy("");
    }
  }

  const nuevos = rows.filter((r) => !dups.has(r.line));
  const total = nuevos.reduce((s, r) => s + r.amount, 0);
  const porCategoria = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of nuevos) m.set(r.category, (m.get(r.category) ?? 0) + r.amount);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [nuevos]);

  async function save() {
    if (!accountId || nuevos.length === 0) return;
    setBusy("save");
    setError("");
    setProgress(0);
    let ok = 0;
    const fallas: string[] = [];
    for (const r of nuevos) {
      try {
        await saveFinanceMovement({
          id: null, date: r.date, accountId, kind: "gasto", amount: r.amount, category: r.category,
          description: r.description, partnerId: null, fromInvestment: false
        });
        ok++;
      } catch (err) {
        fallas.push(`renglón ${r.line}: ${err instanceof Error ? err.message : "error"}`);
      }
      setProgress(ok + fallas.length);
    }
    setBusy("");
    if (fallas.length) setError(`Se cargaron ${ok}; no se pudieron ${fallas.length}: ${fallas.slice(0, 3).join(" · ")}${fallas.length > 3 ? "…" : ""}`);
    if (ok > 0) {
      setRows([]);
      setDups(new Set());
      setErrors([]);
      setFileName("");
      onDone(`Listo: se cargaron ${ok} gastos por ${pesos(total)}.`);
    }
  }

  const columns: Column<ImportRow>[] = [
    { key: "date", header: "Fecha", render: (r) => fecha(r.date), sortValue: (r) => r.date },
    { key: "category", header: "Categoría", render: (r) => r.category, sortValue: (r) => r.category },
    { key: "description", header: "Detalle", main: true, render: (r) => r.description || "-", sortValue: (r) => r.description },
    { key: "amount", header: "Monto", align: "right", render: (r) => pesos(r.amount), sortValue: (r) => r.amount },
    { key: "state", header: "", render: (r) => (dups.has(r.line) ? <Badge tone="neutral">Ya estaba cargado</Badge> : <Badge tone="ok">Se carga</Badge>) }
  ];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <span className="pa-muted" style={{ fontSize: 13 }}>
        Un archivo con columnas <b>fecha</b>, <b>categoría</b>, <b>detalle</b> y <b>monto</b> (separadas por punto y coma). Se cargan como gasto en la
        cuenta que elijas. Lo que ya está cargado el mismo día y por el mismo monto no se repite.
      </span>
      <div className="pa-row" style={{ alignItems: "flex-end" }}>
        <label className="pa-btn pa-btn-secondary" style={{ cursor: "pointer" }}>
          <Upload size={16} /> {fileName || "Elegir archivo"}
          <input type="file" accept=".csv,.txt" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ""; }} />
        </label>
        <div style={{ minWidth: 220 }}>
          <Field label="Salieron de la cuenta">
            {(id) => (
              <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
              </Select>
            )}
          </Field>
        </div>
      </div>
      {busy === "read" && <span className="pa-muted">Leyendo el archivo y buscando lo que ya está cargado…</span>}
      {errors.length > 0 && <Alert tone="warn" title={`${errors.length} renglones no se entienden y no se cargan`}>{errors.slice(0, 5).join(" · ")}{errors.length > 5 ? "…" : ""}</Alert>}
      {error && <Alert tone="danger" onClose={() => setError("")}>{error}</Alert>}
      {rows.length > 0 && (
        <>
          <div className="pa-list-row" style={{ alignItems: "flex-start" }}>
            <span style={{ display: "grid", gap: 4 }}>
              <span><b>{nuevos.length} gastos nuevos por {pesos(total)}</b>{dups.size ? <span className="pa-muted"> · {dups.size} ya estaban cargados</span> : null}</span>
              <span className="pa-muted" style={{ fontSize: 13 }}>{porCategoria.map(([c, v]) => `${c}: ${pesos(v)}`).join(" · ")}</span>
            </span>
            <Button loading={busy === "save"} disabled={!accountId || nuevos.length === 0} onClick={() => void save()}>
              {busy === "save" ? `Cargando ${progress} de ${nuevos.length}…` : `Cargar ${nuevos.length} gastos`}
            </Button>
          </div>
          <DataTable rows={rows} columns={columns} rowKey={(r) => String(r.line)} searchText={(r) => `${r.category} ${r.description}`} searchPlaceholder="Buscar en el archivo" defaultSort={{ key: "date", dir: "asc" }} />
        </>
      )}
    </div>
  );
}
