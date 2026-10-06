import { useMemo, useState } from "react";
import type { Product } from "@patagonia/domain";
import { formatMoney } from "../shifts/format";
import { listProductsForBranch } from "../inventory/inventory-service";
import { useBranchesOverview } from "./useBranchesOverview";
import { quantityNumber } from "../sale/quantity";

// Sucursales: resumen de cada una (stock, ventas de hoy, turno abierto) con
// el total de todas juntas, y transferir stock de una sucursal a otra. Solo
// dueño/administrador (branches.manage), igual que el selector de sucursal
// del menú -- ver migración 098_branches_overview.sql.

function plain(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function ProductPicker({ products, placeholder, onPick }: { products: Product[]; placeholder: string; onPick: (product: Product) => void }) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = plain(query);
    if (!q) return [];
    return products.filter((p) => plain(p.name).includes(q) || plain(p.code).includes(q)).slice(0, 8);
  }, [products, query]);

  return (
    <div className="pos-search-wrap">
      <input
        className="pos-search"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {matches.length > 0 && (
        <div className="pos-dropdown">
          {matches.map((product) => (
            <button
              key={product.id}
              type="button"
              className="pos-dropdown-item"
              onClick={() => {
                onPick(product);
                setQuery("");
              }}
            >
              <span>{product.name} <span className="muted">({product.code})</span></span>
              <strong>{product.stock} {product.unit === "kg" ? "kg" : "u."}</strong>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Branches() {
  const { branches, loading, error, transfer } = useBranchesOverview();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const [fromBranchId, setFromBranchId] = useState("");
  const [toBranchId, setToBranchId] = useState("");
  const [product, setProduct] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [fromProducts, setFromProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);

  const totals = useMemo(
    () =>
      branches.reduce(
        (acc, b) => ({
          stockValue: acc.stockValue + b.stockValue,
          salesTotal: acc.salesTotal + b.salesTodayTotal,
          salesCount: acc.salesCount + b.salesTodayCount
        }),
        { stockValue: 0, salesTotal: 0, salesCount: 0 }
      ),
    [branches]
  );

  async function handleFromChange(id: string) {
    setFromBranchId(id);
    setProduct(null);
    setFromProducts([]);
    if (!id) return;
    setProductsLoading(true);
    try {
      setFromProducts(await listProductsForBranch(id));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo cargar el stock de esa sucursal.");
    } finally {
      setProductsLoading(false);
    }
  }

  async function handleTransfer() {
    setMessage("");
    if (!fromBranchId || !toBranchId) { setMessage("Elegí la sucursal de origen y la de destino."); return; }
    if (fromBranchId === toBranchId) { setMessage("Elegí dos sucursales distintas."); return; }
    if (!product) { setMessage("Buscá y elegí el producto a transferir."); return; }
    const qty = quantityNumber(quantity);
    if (!Number.isFinite(qty) || qty <= 0) { setMessage("Ingresá una cantidad mayor que cero."); return; }
    if (qty > product.stock) { setMessage(`En esa sucursal solo hay ${product.stock} de "${product.name}".`); return; }

    setBusy(true);
    try {
      await transfer({ fromBranchId, toBranchId, productId: product.id, quantity: qty, notes: notes.trim() || undefined });
      const fromName = branches.find((b) => b.branchId === fromBranchId)?.branchName ?? "";
      const toName = branches.find((b) => b.branchId === toBranchId)?.branchName ?? "";
      setMessage(`Listo: se transfirieron ${qty} ${product.unit === "kg" ? "kg" : "unidades"} de ${product.name} de ${fromName} a ${toName}.`);
      setProduct(null);
      setQuantity("");
      setNotes("");
      await handleFromChange(fromBranchId);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo transferir el stock.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">EQUIPO</p>
          <h1>Sucursales</h1>
          <p className="muted">Resumen de cada sucursal y de toda la empresa junta, y traspaso de stock entre sucursales.</p>
        </div>
      </header>

      {message && <div className="message">{message}</div>}
      {error && <div className="message warning">{error}</div>}

      <section className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-title">
          <h2>Todas las sucursales</h2>
          <span>{loading ? "Cargando…" : `${branches.length} sucursales`}</span>
        </div>
        <div className="kpi-grid">
          <div className="kpi-card">
            <span>Stock a costo (total)</span>
            <strong>{formatMoney(totals.stockValue)}</strong>
          </div>
          <div className="kpi-card">
            <span>Vendido hoy (todas)</span>
            <strong>{formatMoney(totals.salesTotal)}</strong>
          </div>
          <div className="kpi-card">
            <span>Ventas hoy (cantidad)</span>
            <strong>{totals.salesCount}</strong>
          </div>
        </div>

        {branches.length > 0 && (
          <table className="data-table" style={{ marginTop: 18 }}>
            <thead>
              <tr>
                <th>Sucursal</th>
                <th>Turno</th>
                <th className="num">Productos con stock</th>
                <th className="num">Stock a costo</th>
                <th className="num">Vendido hoy</th>
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => (
                <tr key={b.branchId}>
                  <td>{b.branchName}</td>
                  <td>{b.shiftOpen ? <span className="status-pill">Abierto</span> : <span className="muted">Cerrado</span>}</td>
                  <td className="num">{b.productCount}</td>
                  <td className="num">{formatMoney(b.stockValue)}</td>
                  <td className="num">{formatMoney(b.salesTodayTotal)} <span className="muted">({b.salesTodayCount})</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && branches.length === 0 && <p className="muted">Todavía no hay sucursales.</p>}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h2>Transferir stock entre sucursales</h2>
        </div>
        <p className="muted" style={{ marginTop: -8, marginBottom: 14 }}>
          Descuenta el producto de la sucursal de origen y lo suma en la de destino, con el mismo criterio que una compra o un ajuste de stock.
        </p>
        <div className="cash-banner-form" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label className="muted" style={{ display: "block", marginBottom: 4 }}>Desde</label>
            <select value={fromBranchId} onChange={(e) => void handleFromChange(e.target.value)}>
              <option value="">Elegí la sucursal de origen…</option>
              {branches.map((b) => (
                <option key={b.branchId} value={b.branchId}>{b.branchName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="muted" style={{ display: "block", marginBottom: 4 }}>Hacia</label>
            <select value={toBranchId} onChange={(e) => setToBranchId(e.target.value)}>
              <option value="">Elegí la sucursal de destino…</option>
              {branches.map((b) => (
                <option key={b.branchId} value={b.branchId} disabled={b.branchId === fromBranchId}>{b.branchName}</option>
              ))}
            </select>
          </div>
        </div>

        {fromBranchId && (
          <div style={{ marginTop: 14 }}>
            <label className="muted" style={{ display: "block", marginBottom: 4 }}>Producto</label>
            {productsLoading ? (
              <p className="muted">Cargando el stock de esa sucursal…</p>
            ) : (
              <ProductPicker products={fromProducts} placeholder="Buscá el producto por nombre o código…" onPick={setProduct} />
            )}
            {product && (
              <p style={{ margin: "8px 0 0" }}>
                <strong>{product.name}</strong> <span className="muted">— disponible: {product.stock} {product.unit === "kg" ? "kg" : "u."}</span>{" "}
                <button className="secondary" onClick={() => setProduct(null)}>Cambiar</button>
              </p>
            )}
          </div>
        )}

        {product && (
          <>
            <div className="cash-banner-form" style={{ flexWrap: "wrap", marginTop: 14 }}>
              <div>
                <label className="muted" style={{ display: "block", marginBottom: 4 }}>Cantidad</label>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder={product.unit === "kg" ? "kg" : "unidades"}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  style={{ width: 100 }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label className="muted" style={{ display: "block", marginBottom: 4 }}>Motivo (opcional)</label>
                <input placeholder="Ej. reparto semanal" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: "100%" }} />
              </div>
            </div>
            <button disabled={busy} style={{ marginTop: 14 }} onClick={() => void handleTransfer()}>
              {busy ? "Transfiriendo…" : "Transferir stock"}
            </button>
          </>
        )}
      </section>
    </>
  );
}
