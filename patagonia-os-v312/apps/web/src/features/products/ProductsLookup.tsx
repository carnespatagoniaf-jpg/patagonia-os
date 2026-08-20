import { useEffect, useRef, useState } from "react";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { formatMoney } from "../shifts/format";
import { listProductPrices, type ProductPriceRow } from "./products-service";

const UNIT_LABELS: Record<ProductPriceRow["unit"], string> = { kg: "kg", unit: "unidad", box: "caja" };

type LabelSize = "chica" | "mediana" | "grande";

const LABEL_SIZE_OPTIONS: { value: LabelSize; label: string; hint: string }[] = [
  { value: "chica", label: "Chica", hint: "para frascos y paquetes chicos (ej. mayonesa)" },
  { value: "mediana", label: "Mediana", hint: "tamaño normal" },
  { value: "grande", label: "Grande", hint: "para cortes o carteles bien visibles" }
];

const LABEL_SIZE_STYLES: Record<LabelSize, { box: string; name: number; price: number; padding: string }> = {
  chica: { box: "260px", name: 16, price: 26, padding: "14px 10px" },
  mediana: { box: "380px", name: 24, price: 40, padding: "30px 16px" },
  grande: { box: "520px", name: 32, price: 56, padding: "50px 24px" }
};

const DEMO_ROWS: ProductPriceRow[] = demoProducts
  .filter((p) => p.active ?? true)
  .map((p) => ({ id: p.id, code: p.code, name: p.name, unit: p.unit, priceRetail: p.priceRetail }));

export function ProductsLookup() {
  const [products, setProducts] = useState<ProductPriceRow[]>(isSupabaseConfigured ? [] : DEMO_ROWS);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [search, setSearch] = useState("");
  const [labelProduct, setLabelProduct] = useState<ProductPriceRow | null>(null);
  const [labelSize, setLabelSize] = useState<LabelSize>("mediana");
  const labelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    listProductPrices()
      .then(setProducts)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (labelProduct) labelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [labelProduct]);

  const filtered = products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
  const sizeStyle = LABEL_SIZE_STYLES[labelSize];

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
                  <button className="secondary" onClick={() => setLabelProduct(product)}>Preparar etiqueta</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && !loading && <p className="muted">No se encontraron productos.</p>}
      </section>

      {labelProduct && (
        <section className="panel print-area" style={{ marginTop: 18, textAlign: "center" }} ref={labelRef}>
          <div className="panel-title no-print">
            <h2>Etiqueta: {labelProduct.name}</h2>
            <div>
              <button className="secondary" onClick={() => setLabelProduct(null)}>Cerrar</button>
            </div>
          </div>
          <div className="cash-banner-form no-print" style={{ justifyContent: "center", marginBottom: 10 }}>
            {LABEL_SIZE_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={labelSize === option.value ? "" : "secondary"}
                onClick={() => setLabelSize(option.value)}
                title={option.hint}
              >
                {option.label}
              </button>
            ))}
            <button onClick={handlePrint}>Imprimir</button>
          </div>
          <p className="muted no-print" style={{ marginBottom: 14 }}>
            {LABEL_SIZE_OPTIONS.find((o) => o.value === labelSize)?.hint} — se imprime en hoja A4, después se recorta.
          </p>
          <div
            style={{
              maxWidth: sizeStyle.box,
              margin: "0 auto",
              padding: sizeStyle.padding,
              border: "1px dashed #999"
            }}
          >
            <p style={{ fontSize: sizeStyle.name, fontWeight: 700, margin: 0 }}>{labelProduct.name}</p>
            <p style={{ fontSize: sizeStyle.price, fontWeight: 800, margin: "10px 0 0" }}>{formatMoney(labelProduct.priceRetail)}</p>
            <p className="muted" style={{ marginTop: 4 }}>por {UNIT_LABELS[labelProduct.unit]}</p>
          </div>
        </section>
      )}
    </>
  );
}
