import { Fragment, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import type { Product } from "@patagonia/domain";
import { downloadCsv, toCsv } from "../../lib/csv";
import { listProductsForBranch } from "../inventory/inventory-service";
import { listProductCategories } from "../inventory/product-categories-service";
import { formatMoney } from "./format";
import { stockValueReport } from "./stock-value";

const qty = (unit: Product["unit"], n: number) =>
  `${n.toLocaleString("es-AR", { maximumFractionDigits: unit === "kg" ? 3 : 0 })} ${unit === "kg" ? "kg" : "u."}`;

/**
 * Reportes → "Stock valorizado" (26/10/2026): cuánto vale hoy la mercadería, a costo y a precio de venta, por
 * categoría y producto. Solo dueño/administrador (muestra costos). No depende de las fechas: es el stock de hoy.
 */
export function ReportsStockValue({ branchId }: { branchId: string | null }) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    Promise.all([listProductsForBranch(branchId), listProductCategories().catch(() => [])])
      .then(([list, cats]) => {
        if (cancelled) return;
        setProducts(list);
        setCategories(cats.map((c) => ({ id: c.id, name: c.name })));
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "No se pudo cargar el stock."));
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  const report = useMemo(() => (products ? stockValueReport(products, categories) : null), [products, categories]);

  function exportCsv() {
    if (!report) return;
    const rows = report.categories.flatMap((c) =>
      c.rows.map((r) => [c.name, r.code, r.name, r.stock, r.unit === "kg" ? "kg" : "unidad", r.cost, r.costValue, r.price, r.saleValue])
    );
    downloadCsv(
      `stock-valorizado-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(["Categoría", "Código", "Producto", "Stock", "Unidad", "Costo unitario", "Valor a costo", "Precio de venta", "Valor a venta"], rows)
    );
  }

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-title">
        <h2>Stock valorizado</h2>
        <span className="muted" style={{ fontSize: 12 }}>Cuánto vale hoy la mercadería que tenés, de qué es</span>
      </div>
      {error ? (
        <p style={{ color: "#8b1e1e" }}>{error}</p>
      ) : !report ? (
        <p className="muted">Cargando…</p>
      ) : report.productsWithStock === 0 && report.negative.length === 0 ? (
        <p className="muted">No hay productos con stock cargado.</p>
      ) : (
        <>
          <div className="kpi-grid" style={{ marginBottom: 12 }}>
            <div className="kpi-card"><span>A costo (lo que pagaste)</span><strong>{formatMoney(report.costValue)}</strong></div>
            <div className="kpi-card"><span>A precio de venta</span><strong>{formatMoney(report.saleValue)}</strong></div>
            <div className="kpi-card"><span>Ganancia si vendés todo</span><strong>{formatMoney(report.profit)}</strong></div>
            <div className="kpi-card"><span>Productos con stock</span><strong>{report.productsWithStock}</strong></div>
          </div>
          {report.noCostCount > 0 && (
            <p className="setting-help">{report.noCostCount === 1 ? "1 producto tiene" : `${report.noCostCount} productos tienen`} stock pero no tienen costo cargado: a costo cuentan $0. Cargá el costo en Stock.</p>
          )}
          <table>
            <thead>
              <tr>
                <th>Categoría / producto</th>
                <th className="num">Stock</th>
                <th className="num">Costo</th>
                <th className="num">Valor a costo</th>
                <th className="num">Valor a venta</th>
                <th className="num">% del total</th>
              </tr>
            </thead>
            <tbody>
              {report.categories.map((c) => {
                const key = c.id ?? "none";
                const isOpen = open === key;
                return (
                  <Fragment key={key}>
                    <tr style={{ cursor: "pointer" }} onClick={() => setOpen(isOpen ? null : key)}>
                      <td><strong>{isOpen ? "▾" : "▸"} {c.name}</strong> <span className="muted">({c.rows.length})</span></td>
                      <td></td>
                      <td></td>
                      <td className="num"><strong>{formatMoney(c.costValue)}</strong></td>
                      <td className="num">{formatMoney(c.saleValue)}</td>
                      <td className="num">{report.costValue > 0 ? `${((c.costValue / report.costValue) * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })}%` : "—"}</td>
                    </tr>
                    {isOpen && c.rows.map((r) => (
                      <tr key={r.id}>
                        <td style={{ paddingLeft: 28 }}>{r.name} <span className="muted">· {r.code}</span></td>
                        <td className="num">{qty(r.unit, r.stock)}</td>
                        <td className="num">{r.noCost ? <span style={{ color: "#8b1e1e" }}>sin costo</span> : formatMoney(r.cost)}</td>
                        <td className="num">{formatMoney(r.costValue)}</td>
                        <td className="num">{formatMoney(r.saleValue)}</td>
                        <td className="num muted">{report.costValue > 0 ? `${((r.costValue / report.costValue) * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })}%` : "—"}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {report.negative.length > 0 && (
            <p className="setting-help" style={{ marginTop: 10 }}>
              En negativo (no suman: se vendió más de lo cargado; corregilo con Stock → "Ajustar stock"):{" "}
              {report.negative.map((r) => `${r.name} ${qty(r.unit, r.stock)}`).join(", ")}.
            </p>
          )}
          <div style={{ marginTop: 10 }}>
            <button className="secondary" onClick={exportCsv}><Download size={14} /> Bajar en Excel (CSV)</button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>Las ofertas que usan el stock de otro producto se cuentan en el producto principal. Valores al costo y precio cargados hoy en Stock.</p>
        </>
      )}
    </section>
  );
}
