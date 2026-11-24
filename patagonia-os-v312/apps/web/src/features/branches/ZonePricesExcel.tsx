import { useRef, useState } from "react";
import type { Product } from "@patagonia/domain";
import { formatMoney } from "../shifts/format";
import { decodeFileBytes, parseDelimited, type Cell, type Table } from "../import/import-parse";
import { savePriceZone, setProductListPrices } from "../pricing/price-lists-service";
import type { PriceList } from "../pricing/price-lists";
import type { TransferBranch } from "../transfers/transfers-service";
import { chunk, readZonePrices, zonePricesSheet, type ImportBranch, type ZonePricesImport } from "./zone-prices-import";

// Pantalla a pedido 'precios_excel' (migración 211; por ahora solo Della Finca): bajar y subir los precios de cada local en un Excel.
// La lógica (qué columna va a qué zona) está en zone-prices-import.ts, probada.

const SHOW_MAX = 15;

export function ZonePricesExcel({
  products,
  branches,
  zones,
  zoneBranches,
  onSaved
}: {
  products: Product[];
  branches: TransferBranch[];
  zones: PriceList[];
  zoneBranches: Map<string, string[]>;
  onSaved: (message: string) => Promise<void>;
}) {
  const [plan, setPlan] = useState<(ZonePricesImport & { fileName: string }) | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const branchZone = new Map<string, string>();
  for (const [zoneId, ids] of zoneBranches) for (const id of ids) branchZone.set(id, zoneId);
  const importBranches: ImportBranch[] = branches.map((b) => ({ id: b.id, name: b.name, zoneId: branchZone.get(b.id) ?? null }));
  const importProducts = products.map((p) => ({ id: p.id, code: p.code, name: p.name, listPrices: p.listPrices, priceRetail: p.priceRetail }));

  async function download() {
    setError("");
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(zonePricesSheet(importProducts, importBranches));
      ws["!cols"] = [{ wch: 10 }, { wch: 32 }, ...importBranches.map(() => ({ wch: 12 })), { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws, "Precios por local");
      XLSX.writeFile(wb, `Precios_por_local_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo armar la planilla.");
    }
  }

  async function handleFile(file: File) {
    setError("");
    setPlan(null);
    try {
      let table: Table;
      if (/\.xlsx$/i.test(file.name)) {
        const { readSheet } = await import("read-excel-file/browser");
        table = (await readSheet(file)) as Cell[][];
      } else if (/\.xls$/i.test(file.name)) {
        throw new Error('Ese es un Excel viejo (.xls). Abrilo en Excel y guardalo como "Libro de Excel (.xlsx)" y subilo de nuevo.');
      } else {
        table = parseDelimited(decodeFileBytes(await file.arrayBuffer()));
      }
      setPlan({ ...readZonePrices(table, importProducts, importBranches, zones), fileName: file.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo leer el archivo.");
    }
  }

  async function save() {
    if (!plan) return;
    setBusy(true);
    setError("");
    let saved = 0;
    try {
      const items: { productId: string; listId: string; price: number }[] = [];
      const created: string[] = [];
      for (const col of plan.columns) {
        if (col.prices.size === 0) continue;
        let listId: string;
        if (col.target.kind === "new-zone") {
          listId = await savePriceZone({ id: null, name: col.target.label, pct: 0, branchIds: [col.target.branchId] });
          created.push(col.target.label);
        } else {
          listId = col.target.zoneId;
        }
        const zoneId = col.target.kind === "zone" ? col.target.zoneId : null;
        for (const [productId, price] of col.prices) {
          const cur = zoneId ? products.find((p) => p.id === productId)?.listPrices?.[zoneId] : undefined;
          if (cur?.manual && cur.price === price) continue;
          items.push({ productId, listId, price });
        }
      }
      for (const part of chunk(items)) {
        await setProductListPrices(part);
        saved += part.length;
      }
      setPlan(null);
      await onSaved(
        `Listo: se guardaron ${saved} precio${saved === 1 ? "" : "s"}` +
          (created.length ? ` y se creó la zona de ${created.join(", ")}` : "") +
          ". Mostrador de cada local ya cobra estos precios. Mandá los precios a la balanza de cada local (Stock → Balanza)."
      );
    } catch (err) {
      const why = err instanceof Error ? err.message : "error desconocido";
      setError(saved > 0 ? `Se guardaron ${saved} precios y después falló: ${why}. Volvé a subir el archivo para terminar.` : `No se pudo guardar: ${why}`);
    } finally {
      setBusy(false);
    }
  }

  const total = plan?.columns.reduce((s, c) => s + c.changed, 0) ?? 0;
  const zoneLabel = (zoneId: string) => zones.find((z) => z.id === zoneId)?.name ?? "";

  return (
    <div className="form-box" style={{ marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>Precios de cada local desde Excel</h3>
      <p className="muted">
        Bajá la planilla: trae el código, el producto y una columna por local con el precio que cobra hoy. Cambiá los precios en Excel y subila.
        Una celda vacía deja ese precio como está.
      </p>
      <div className="form-actions">
        <button type="button" className="secondary" onClick={() => void download()}>Bajar planilla</button>
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>Subir Excel</button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt" hidden aria-label="Excel con los precios de cada local" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }} />
      </div>
      {error && <div className="message">{error}</div>}
      {plan && (
        <div style={{ marginTop: 10 }}>
          <p><b>{plan.fileName}</b>: {plan.rows} producto{plan.rows === 1 ? "" : "s"} encontrados.</p>
          <div className="table-scroll">
            <table className="data-table no-stack">
              <thead>
                <tr><th>Columna</th><th>Se carga en</th><th className="num">Precios</th><th className="num">Cambian</th></tr>
              </thead>
              <tbody>
                {plan.columns.map((c) => (
                  <tr key={c.index}>
                    <td>{c.header}</td>
                    <td>{c.target.kind === "new-zone" ? <>zona nueva <b>{c.target.label}</b> (solo ese local)</> : <>zona <b>{zoneLabel(c.target.zoneId)}</b></>}</td>
                    <td className="num">{c.prices.size}</td>
                    <td className="num">{c.changed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.shared.length > 0 && (
            <p className="message">
              {plan.shared.map((s) => `"${s.header}" está en la zona ${s.zoneName} con otros locales`).join("; ")}: esa columna no se carga (cambiaría el precio de los otros). Poné de encabezado el nombre de la zona.
            </p>
          )}
          {plan.unknown.length > 0 && (
            <p className="muted">
              {plan.unknown.length} fila{plan.unknown.length === 1 ? "" : "s"} con un producto que no existe (no se cargan):{" "}
              {plan.unknown.slice(0, SHOW_MAX).map((u) => `fila ${u.row} (${u.text})`).join(", ")}
              {plan.unknown.length > SHOW_MAX ? "…" : ""}
            </p>
          )}
          {plan.errors.length > 0 && (
            <p className="muted">
              {plan.errors.length} celda{plan.errors.length === 1 ? "" : "s"} que no son un precio (no se cargan):{" "}
              {plan.errors.slice(0, SHOW_MAX).map((e) => `fila ${e.row} ${e.header} "${e.text}"`).join(", ")}
              {plan.errors.length > SHOW_MAX ? "…" : ""}
            </p>
          )}
          {plan.ignored.length > 0 && <p className="muted">Columnas que no son un local (no se usan): {plan.ignored.join(", ")}.</p>}
          <div className="form-actions">
            <button type="button" disabled={busy || total === 0} onClick={() => void save()}>
              {busy ? "Guardando…" : total === 0 ? "No cambia ningún precio" : `Guardar ${total} precio${total === 1 ? "" : "s"}`}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setPlan(null)}>Cancelar</button>
          </div>
          {total > 0 && <p className="muted">Ejemplo: {exampleLine(plan, products)}</p>}
        </div>
      )}
    </div>
  );
}

function exampleLine(plan: ZonePricesImport, products: Product[]): string {
  const col = plan.columns.find((c) => c.prices.size > 0);
  if (!col) return "";
  const [productId, price] = [...col.prices][0];
  const p = products.find((x) => x.id === productId);
  return `${p?.name ?? ""} en ${col.target.label}: ${formatMoney(price)} (general ${formatMoney(p?.priceRetail ?? 0)}).`;
}
