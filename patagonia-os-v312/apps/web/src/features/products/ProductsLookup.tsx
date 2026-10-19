import { useEffect, useRef, useState } from "react";
import { demoProducts } from "../../lib/demo-data";
import { isSupabaseConfigured } from "../../lib/supabase";
import { formatMoney } from "../shifts/format";
import { ScaleSyncPanel } from "../inventory/ScaleSyncPanel";
import { MyScale } from "../scales/MyScale";
import { ScaleSupportTools } from "../scales/ScaleSupportTools";
import { ScaleButton } from "../scales/ScaleButton";
import { useActiveBranch } from "../branches/BranchProvider";
import { useAuth } from "../auth/AuthProvider";
import { planAllows } from "../auth/permissions";
import { compareByCode, getCompanyName, listProductPrices, type ProductPriceRow } from "./products-service";
import { buildPosterHtml, defaultDetail } from "./price-poster";

const UNIT_LABELS: Record<ProductPriceRow["unit"], string> = { kg: "kg", unit: "unidad", box: "caja" };

type LabelSize = "chica" | "mediana" | "grande" | "cartel";

const LABEL_SIZE_OPTIONS: { value: LabelSize; label: string; hint: string }[] = [
  { value: "chica", label: "Chica", hint: "para frascos y paquetes chicos (ej. mayonesa)" },
  { value: "mediana", label: "Mediana", hint: "tamaño normal" },
  { value: "grande", label: "Grande", hint: "para cortes o carteles bien visibles" },
  { value: "cartel", label: "Cartel A4", hint: "cartel grande para el mostrador, media hoja A4" }
];

const LABEL_SIZE_STYLES: Record<Exclude<LabelSize, "cartel">, { box: string; name: number; price: number; padding: string }> = {
  chica: { box: "260px", name: 16, price: 26, padding: "14px 10px" },
  mediana: { box: "380px", name: 24, price: 40, padding: "30px 16px" },
  grande: { box: "520px", name: 32, price: 56, padding: "50px 24px" }
};

// Hoja A4 real (96 dpi) achicada para la vista previa del cartel.
const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;
const POSTER_PREVIEW_SCALE = 0.45;

// El cartel A4 se imprime desde un iframe propio (su HTML trae @page A4 sin
// márgenes), así no depende del CSS de impresión general de la app.
function printPosterHtml(html: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    win.focus();
    win.print();
    setTimeout(() => frame.remove(), 1000);
  }, 250);
}

const DEMO_ROWS: ProductPriceRow[] = demoProducts
  .filter((p) => p.active ?? true)
  .map((p) => ({ id: p.id, code: p.code, name: p.name, unit: p.unit, priceRetail: p.priceRetail }))
  .sort((a, b) => compareByCode(a.code, b.code));

export function ProductsLookup() {
  const [products, setProducts] = useState<ProductPriceRow[]>(isSupabaseConfigured ? [] : DEMO_ROWS);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [search, setSearch] = useState("");
  const [labelProduct, setLabelProduct] = useState<ProductPriceRow | null>(null);
  const [labelSize, setLabelSize] = useState<LabelSize>("mediana");
  const labelRef = useRef<HTMLElement>(null);
  const [companyName, setCompanyName] = useState(isSupabaseConfigured ? "" : "Carnes Patagonia");
  const { profile } = useAuth();
  const { branchId } = useActiveBranch();

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    setLoading(true);
    listProductPrices()
      .then(setProducts)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    getCompanyName(profile?.company_id).then(setCompanyName);
  }, [profile?.company_id]);

  useEffect(() => {
    if (labelProduct) labelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [labelProduct]);

  // Sin importar acentos ni mayúsculas ("cajon" encuentra "Cajón").
  const plain = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const searchText = plain(search);
  const filtered = products.filter((p) => plain(p.name).includes(searchText) || plain(p.code).includes(searchText));
  const sizeStyle = labelSize === "cartel" ? null : LABEL_SIZE_STYLES[labelSize];
  const posterHtml =
    labelProduct && labelSize === "cartel"
      ? buildPosterHtml({ business: companyName, name: labelProduct.name, price: labelProduct.priceRetail, detail: defaultDetail(labelProduct.unit) })
      : "";

  function handlePrint() {
    if (posterHtml) printPosterHtml(posterHtml);
    else window.print();
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">PRODUCTOS</p>
          <h1>Productos y precios</h1>
          <p className="muted">Consultá el precio de venta de cualquier producto, o imprimí una etiqueta para la góndola.</p>
        </div>
        {planAllows(profile, "estandar") && (
          <ScaleButton>
            <MyScale products={products} branchId={branchId} />
            <ScaleSupportTools>
              <ScaleSyncPanel products={products} />
            </ScaleSupportTools>
          </ScaleButton>
        )}
      </header>

      <section className="panel">
        <div className="panel-title">
          <h2>Buscar producto</h2>
          <span>{loading ? "Cargando…" : `${filtered.length} productos`}</span>
        </div>
        <input
          type="text"
          placeholder="Buscar por nombre o código…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginBottom: 14, width: "100%", maxWidth: 320 }}
        />
        <table className="data-table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Producto</th>
              <th className="num">Precio</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((product) => (
              <tr key={product.id}>
                <td>{product.code}</td>
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
          {posterHtml && (
            <div
              className="no-print"
              style={{
                width: A4_WIDTH_PX * POSTER_PREVIEW_SCALE,
                height: (A4_HEIGHT_PX / 2) * POSTER_PREVIEW_SCALE,
                margin: "0 auto",
                overflow: "hidden",
                boxShadow: "0 1px 6px rgba(0,0,0,.18)",
                background: "#fff"
              }}
            >
              <iframe
                title="Vista previa del cartel"
                srcDoc={posterHtml}
                style={{
                  width: A4_WIDTH_PX,
                  height: A4_HEIGHT_PX,
                  border: 0,
                  transform: `scale(${POSTER_PREVIEW_SCALE})`,
                  transformOrigin: "0 0",
                  pointerEvents: "none"
                }}
              />
            </div>
          )}
          {sizeStyle && (
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
          )}
        </section>
      )}
    </>
  );
}
