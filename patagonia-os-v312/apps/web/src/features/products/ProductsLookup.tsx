import { useEffect, useState } from "react";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { formatMoney } from "../shifts/format";
import { listProductPrices, type ProductPriceRow } from "./products-service";

const UNIT_LABELS: Record<ProductPriceRow["unit"], string> = { kg: "kg", unit: "unidad", box: "caja" };

const DEMO_ROWS: ProductPriceRow[] = demoProducts
  .filter((p) => p.active ?? true)
  .map((p) => ({ id: p.id, code: p.code, name: p.name, unit: p.unit, priceRetail: p.priceRetail }));

export function ProductsLookup() {
  const [products, setProducts] = useState<ProductPriceRow[]>(isSupabaseConfigured ? [] : DEMO_ROWS);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [search, setSearch] = useState("");
  const [labelProduct, setLabelProduct] = useState<ProductPriceRow | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    listProductPrices()
      .then(setProducts)
      .finally(() => setLoading(false));
  }, []);

  const filtered = products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));

  function handlePrint() {
    window.print();
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">PRODUCTOS</p>
          <h1>Productos y precios</h1>
          <p className="muted">Consultá el precio de venta de cualquier producto, o imprimí una etiqueta para la góndola.</p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-title">
          <h2>Buscar producto</h2>
          <span>{loading ? "Cargando…" : `${filtered.length} productos`}</span>
        </div>
        <input
          type="text"
          placeholder="Buscar por nombre…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginBottom: 14, width: "100%", maxWidth: 320 }}
        />
        <table className="data-table">
          <thead>
            <tr>
              <th>Producto</th>
              <th className="num">Precio</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((product) => (
              <tr key={product.id}>
                <td>{product.name} <span className="muted">({UNIT_LABELS[product.unit]})</span></td>
                <td className="num">{formatMoney(product.priceRetail)}</td>
                <td>
                  <button className="secondary" onClick={() => setLabelProduct(product)}>Imprimir etiqueta</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && !loading && <p className="muted">No se encontraron productos.</p>}
      </section>

      {labelProduct && (
        <section className="panel print-area" style={{ marginTop: 18, textAlign: "center" }}>
          <div className="panel-title no-print">
            <h2>Etiqueta</h2>
            <div>
              <button className="secondary" onClick={handlePrint}>Imprimir</button>{" "}
              <button className="secondary" onClick={() => setLabelProduct(null)}>Cerrar</button>
            </div>
          </div>
          <div style={{ padding: "40px 20px" }}>
            <p style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>{labelProduct.name}</p>
            <p style={{ fontSize: 48, fontWeight: 800, margin: "16px 0 0" }}>{formatMoney(labelProduct.priceRetail)}</p>
            <p className="muted" style={{ marginTop: 4 }}>por {UNIT_LABELS[labelProduct.unit]}</p>
          </div>
        </section>
      )}
    </>
  );
}
